import { EventEmitter } from 'events'
import { Logger, LoggerOptions } from 'node-log-it'
import { merge, map, takeRight, includes, find } from 'lodash'
import { Mongoose } from 'mongoose'
import { MongodbValidator } from '../validators/mongodb-validator'
import { BlockDao } from './mongodb/block-dao'
import { BlockMetaDao } from './mongodb/block-meta-dao'
import { TransactionMetaDao } from './mongodb/transaction-meta-dao'

const mongoose = new Mongoose()
mongoose.Promise = global.Promise // Explicitly supply promise library (http://mongoosejs.com/docs/promises.html)

const MODULE_NAME = 'MongodbStorage'
const DEFAULT_OPTIONS: MongodbStorageOptions = {
  connectOnInit: true,
  reviewIndexesOnConnect: false,
  userAgent: 'Unknown',
  collectionNames: {
    blocks: 'blocks',
    blockMetas: 'block_metas',
    transactionMetas: 'transaction_metas',
  },
  loggerOptions: {},
}

export interface MongodbStorageOptions {
  connectOnInit?: boolean
  reviewIndexesOnConnect?: boolean
  connectionString?: string
  userAgent?: string
  collectionNames?: {
    blocks?: string
    blockMetas?: string
    transactionMetas?: string
  }
  loggerOptions?: LoggerOptions
}

export class MongodbStorage extends EventEmitter {
  private _isReady = false
  private blockDao: BlockDao
  private blockMetaDao: BlockMetaDao
  private transactionMetaDao: TransactionMetaDao
  private options: MongodbStorageOptions
  private logger: Logger

  constructor(options: MongodbStorageOptions = {}) {
    super()

    // Associate optional properties
    this.options = merge({}, DEFAULT_OPTIONS, options)
    this.validateOptionalParameters()

    // Bootstrapping
    this.logger = new Logger(MODULE_NAME, this.options.loggerOptions)
    this.blockDao = new BlockDao(mongoose, this.options.collectionNames!.blocks!)
    this.blockMetaDao = new BlockMetaDao(mongoose, this.options.collectionNames!.blockMetas!)
    this.transactionMetaDao = new TransactionMetaDao(mongoose, this.options.collectionNames!.transactionMetas!)
    this.initConnection()

    // Event handlers
    this.on('ready', this.readyHandler.bind(this))

    this.logger.debug('constructor completes.')
  }

  isReady(): boolean {
    return this._isReady
  }

  /**
   * @deprecated
   */
  async getBlockCount(): Promise<number> {
    throw new Error('getBlockCount() method is deprecated. Please use getHighestBlockHeight() instead.')
  }

  async getHighestBlockHeight(): Promise<number> {
    this.logger.debug('getBlockCount triggered.')
    return await this.blockDao.getHighestHeight()
  }

  async setBlockCount(height: number): Promise<void> {
    throw new Error('Not implemented.')
  }

  async countBlockRedundancy(height: number): Promise<number> {
    this.logger.debug('countBlockRedundancy triggered. height:', height)
    return await this.blockDao.countByHeight(height)
  }

  async getBlock(height: number): Promise<object> {
    this.logger.debug('getBlock triggered. height:', height)

    const doc: any = await this.blockDao.getByHeight(height)
    if (!doc) {
      throw new Error('No document found.')
    }
    if (!doc.payload) {
      throw new Error('Invalid document result.')
    }
    return doc.payload
  }

  async getBlocks(height: number): Promise<object[]> {
    this.logger.debug('getBlocks triggered. height:', height)

    const docs = await this.blockDao.listByHeight(height)
    if (docs.length === 0) {
      return []
    }
    const blocks = map(docs, (doc: any) => doc.payload)
    return blocks
  }

  async getTransaction(transactionId: string): Promise<object> {
    this.logger.debug('getTransaction triggered.')

    const doc: any = await this.blockDao.getByTransactionId(transactionId)
    if (!doc) {
      // TODO: undesirable business logic, should return undefined instead.
      throw new Error('No result found.')
    }
    const transaction = find(doc.payload.tx, (t: any) => t.txid === transactionId)
    return transaction
  }

  async setBlock(height: number, block: object, options: object = {}): Promise<void> {
    this.logger.debug('setBlock triggered.')

    const data = {
      height,
      source: (options as any).source,
      userAgent: (options as any).userAgent, // Source RPC's user agent
      createdBy: this.options.userAgent, // neo-js's user agent
      payload: block,
    }
    await this.blockDao.save(data)
  }

  async pruneBlock(height: number, redundancySize: number): Promise<void> {
    this.logger.debug('pruneBlock triggered. height: ', height, 'redundancySize:', redundancySize)

    const docs = await this.blockDao.listByHeight(height)
    this.logger.debug('blockDao.listByHeight() succeed. docs.length:', docs.length)

    if (docs.length > redundancySize) {
      const takeCount = docs.length - redundancySize
      const toPrune = takeRight(docs, takeCount)
      // TODO: allow all removal tasks to run in parallel via Promise.all()
      toPrune.forEach(async (doc: any) => {
        this.logger.debug('Removing document id:', doc._id)
        try {
          await this.blockDao.deleteManyById(doc._id)
          this.logger.debug('blockDao.deleteManyById() execution succeed.')
        } catch (err) {
          this.logger.debug('blockDao.deleteManyById() execution failed. error:', err.message)
          // Suppress error and continue
        }
      })
    }
  }

  async analyzeBlocks(startHeight: number, endHeight: number): Promise<object[]> {
    this.logger.debug('analyzeBlockHeight triggered.')
    return await this.blockDao.analyze(startHeight, endHeight)
  }

  async getBlockMetaCount(): Promise<number> {
    this.logger.debug('getBlockMetaCount triggered.')
    return await this.blockMetaDao.count()
  }

  async getHighestBlockMetaHeight(): Promise<number> {
    this.logger.debug('getHighestBlockMetaHeight triggered.')
    return await this.blockMetaDao.getHighestHeight()
  }

  async setBlockMeta(blockMeta: object): Promise<void> {
    this.logger.debug('setBlockMeta triggered.')

    const data = {
      createdBy: this.options.userAgent, // neo-js's user agent
      ...blockMeta,
    }
    return await this.blockMetaDao.save(data)
  }

  async setTransactionMeta(transactionMeta: object): Promise<void> {
    this.logger.debug('setTransactionMeta triggered.')

    const data = {
      createdBy: this.options.userAgent, // neo-js's user agent
      ...transactionMeta,
    }
    return await this.transactionMetaDao.save(data)
  }

  async analyzeBlockMetas(startHeight: number, endHeight: number): Promise<object[]> {
    this.logger.debug('analyzeBlockMetas triggered.')
    return await this.blockMetaDao.analyze(startHeight, endHeight)
  }

  async analyzeTransactionMetas(startHeight: number, endHeight: number): Promise<object[]> {
    this.logger.debug('analyzeTransactionMetas triggered.')
    return await this.transactionMetaDao.analyze(startHeight, endHeight)
  }

  async removeBlockMetaByHeight(height: number): Promise<void> {
    this.logger.debug('removeBlockMetaByHeight triggered. height: ', height)
    return await this.blockMetaDao.removeByHeight(height)
  }

  async countLegacyTransactionMeta(targetApiLevel: number): Promise<number> {
    return await this.transactionMetaDao.countByBelowApiLevel(targetApiLevel)
  }

  async pruneLegacyTransactionMeta(targetApiLevel: number): Promise<void> {
    return await this.transactionMetaDao.removeByBelowApiLevel(targetApiLevel)
  }

  async close(): Promise<void> {
    this.logger.debug('close triggered.')
    return await mongoose.disconnect()
  }

  private readyHandler(payload: any) {
    this.logger.debug('readyHandler triggered.')
    if (this.options.reviewIndexesOnConnect) {
      this.reviewIndexes()
    }
  }

  private validateOptionalParameters() {
    // TODO
  }

  private initConnection() {
    if (this.options.connectOnInit) {
      this.logger.debug('initConnection triggered.')
      MongodbValidator.validateConnectionString(this.options.connectionString!)

      mongoose
        .connect(
          this.options.connectionString!,
          { useCreateIndex: true, useNewUrlParser: true }
        )
        .then(() => {
          this.logger.info('MongoDB connected.')
          this.setReady()
        })
        .catch((err: any) => {
          this.logger.error('Error establish MongoDB connection.')
          throw err
        })
    }
  }

  private setReady() {
    this._isReady = true
    this.emit('ready')
  }

  private async reviewIndexes(): Promise<void> {
    this.logger.debug('Proceed to review indexes...')
    this.emit('reviewIndexes:init')

    try {
      await this.reviewBlockIndexForHeight()
      await this.reviewBlockIndexForTransactionId()
      await this.reviewBlockMetaIndexForHeight()
      await this.reviewBlockMetaIndexForTime()
      await this.reviewTransactionMetaIndexForHeight()
      await this.reviewTransactionMetaIndexForTime()
      await this.reviewTransactionMetaIndexForTransactionId()
      await this.reviewTransactionMetaIndexForType()
      this.logger.debug('Review indexes succeed.')
      this.emit('reviewIndexes:complete', { isSuccess: true })
    } catch (err) {
      this.logger.debug('reviewIndexes failed. Message:', err.message)
      this.emit('reviewIndexes:complete', { isSuccess: false })
    }
  }

  private async reviewBlockIndexForHeight(): Promise<void> {
    this.logger.debug('reviewBlockIndexForHeight triggered.')
    const key = 'height_1_createdAt_-1'
    const keyObj = { height: 1, createdAt: -1 }
    return await this.blockDao.reviewIndex(key, keyObj)
  }

  private async reviewBlockIndexForTransactionId(): Promise<void> {
    this.logger.debug('reviewBlockIndexForTransactionId triggered.')
    const key = 'payload.tx.txid_1'
    const keyObj = { 'payload.tx.txid': 1 }
    return await this.blockDao.reviewIndex(key, keyObj)
  }

  private async reviewBlockMetaIndexForHeight(): Promise<void> {
    this.logger.debug('reviewBlockMetaIndexForHeight triggered.')
    const key = 'height_1'
    const keyObj = { height: 1 }
    return await this.blockMetaDao.reviewIndex(key, keyObj)
  }

  private async reviewBlockMetaIndexForTime(): Promise<void> {
    this.logger.debug('reviewBlockMetaIndexForTime triggered.')
    const key = 'time_1'
    const keyObj = { time: 1 }
    return await this.blockMetaDao.reviewIndex(key, keyObj)
  }

  private async reviewTransactionMetaIndexForHeight(): Promise<void> {
    this.logger.debug('reviewTransactionMetaIndexForHeight triggered.')
    const key = 'height_1'
    const keyObj = { height: 1 }
    return await this.transactionMetaDao.reviewIndex(key, keyObj)
  }

  private async reviewTransactionMetaIndexForTime(): Promise<void> {
    this.logger.debug('reviewTransactionMetaIndexForTime triggered.')
    const key = 'time_1'
    const keyObj = { time: 1 }
    return await this.transactionMetaDao.reviewIndex(key, keyObj)
  }

  private async reviewTransactionMetaIndexForTransactionId(): Promise<void> {
    this.logger.debug('reviewTransactionMetaIndexForTransactionId triggered.')
    const key = 'transactionId_1'
    const keyObj = { transactionId: 1 }
    return await this.transactionMetaDao.reviewIndex(key, keyObj)
  }

  private async reviewTransactionMetaIndexForType(): Promise<void> {
    this.logger.debug('reviewTransactionMetaIndexForType triggered.')
    const key = 'type_1'
    const keyObj = { type: 1 }
    return await this.transactionMetaDao.reviewIndex(key, keyObj)
  }
}
