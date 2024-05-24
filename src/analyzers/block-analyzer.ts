import { EventEmitter } from 'events'
import { priorityQueue, AsyncPriorityQueue } from 'async'
import { Logger, LoggerOptions } from 'node-log-it'
import { merge, map, filter, difference, isArray, uniq } from 'lodash'
import { MemoryStorage } from '../storages/memory-storage'
import { MongodbStorage } from '../storages/mongodb-storage'
import { BlockHelper } from '../helpers/block-helper'

const MODULE_NAME = 'BlockAnalyzer'
const DEFAULT_OPTIONS: BlockAnalyzerOptions = {
  minHeight: 1,
  maxHeight: undefined,
  startOnInit: true,
  toEvaluateTransactions: true,
  toEvaluateAssets: false,
  blockQueueConcurrency: 5,
  transactionQueueConcurrency: 10,
  enqueueEvaluateBlockIntervalMs: 5 * 1000,
  verifyBlocksIntervalMs: 30 * 1000,
  maxBlockQueueLength: 30 * 1000,
  maxTransactionQueueLength: 100 * 1000,
  standardEvaluateBlockPriority: 5,
  missingEvaluateBlockPriority: 3,
  legacyEvaluateBlockPriority: 3,
  standardEvaluateTransactionPriority: 5,
  missingEvaluateTransactionPriority: 5,
  legacyEvaluateTransactionPriority: 5,
  loggerOptions: {},
}

export interface BlockAnalyzerOptions {
  minHeight?: number
  maxHeight?: number
  startOnInit?: boolean
  toEvaluateTransactions?: boolean
  toEvaluateAssets?: boolean
  blockQueueConcurrency?: number
  transactionQueueConcurrency?: number
  enqueueEvaluateBlockIntervalMs?: number
  verifyBlocksIntervalMs?: number
  maxBlockQueueLength?: number
  maxTransactionQueueLength?: number
  standardEvaluateBlockPriority?: number
  missingEvaluateBlockPriority?: number
  legacyEvaluateBlockPriority?: number
  standardEvaluateTransactionPriority?: number
  missingEvaluateTransactionPriority?: number
  legacyEvaluateTransactionPriority?: number
  loggerOptions?: LoggerOptions
}

export class BlockAnalyzer extends EventEmitter {
  /**
   * Flags for determine version of the metadata (akin to Android API level)
   */
  private BLOCK_META_API_LEVEL = 1
  private TRANSACTION_META_API_LEVEL = 1
  private _isRunning = false
  private blockQueue: AsyncPriorityQueue<object>
  private transactionQueue: AsyncPriorityQueue<object>
  private blockWritePointer: number = 0
  private storage?: MemoryStorage | MongodbStorage
  private options: BlockAnalyzerOptions
  private logger: Logger
  private enqueueEvaluateBlockIntervalId?: NodeJS.Timer
  private blockVerificationIntervalId?: NodeJS.Timer
  private isVerifyingBlocks = false

  constructor(storage?: MemoryStorage | MongodbStorage, options: BlockAnalyzerOptions = {}) {
    super()

    // Associate required properties
    this.storage = storage

    // Associate optional properties
    this.options = merge({}, DEFAULT_OPTIONS, options)
    this.validateOptionalParameters()

    // Bootstrapping
    this.logger = new Logger(MODULE_NAME, this.options.loggerOptions)
    this.blockQueue = this.getPriorityQueue(this.options.blockQueueConcurrency!)
    this.transactionQueue = this.getPriorityQueue(this.options.transactionQueueConcurrency!)
    if (this.options.startOnInit) {
      this.start()
    }

    this.logger.debug('constructor completes.')
  }

  isRunning(): boolean {
    return this._isRunning
  }

  start() {
    if (this._isRunning) {
      this.logger.info('BlockAnalyzer has already started.')
      return
    }

    if (!this.storage) {
      this.logger.info('Unable to start BlockAnalyzer when no storage are defined.')
      return
    }

    this.logger.info('Start BlockAnalyzer.')
    this._isRunning = true
    this.emit('start')

    this.initEvaluateBlock()
    this.initBlockVerification()
  }

  stop() {
    if (!this._isRunning) {
      this.logger.info('BlockAnalyzer is not running at the moment.')
      return
    }

    this.logger.info('Stop BlockAnalyzer.')
    this._isRunning = false
    this.emit('stop')

    clearInterval(this.enqueueEvaluateBlockIntervalId!)
    clearInterval(this.blockVerificationIntervalId!)
  }

  close() {
    this.stop()
  }

  private validateOptionalParameters() {
    // TODO
  }

  private getPriorityQueue(concurrency: number): AsyncPriorityQueue<object> {
    return priorityQueue((task: object, callback: () => void) => {
      const method: (attrs: object) => Promise<any> = (task as any).method
      const attrs: object = (task as any).attrs
      const meta: object = (task as any).meta
      this.logger.debug('New worker for queue. meta:', meta, 'attrs:', attrs)

      method(attrs)
        .then(() => {
          callback()
          this.logger.debug('Worker queued method completed.')
          this.emit('queue:worker:complete', { isSuccess: true, task })
        })
        .catch((err: any) => {
          this.logger.info('Worker queued method failed, but to continue... meta:', meta, 'Message:', err.message)
          callback()
          this.emit('queue:worker:complete', { isSuccess: false, task })
        })
    }, concurrency)
  }

  private initEvaluateBlock() {
    this.logger.debug('initEvaluateBlock triggered.')
    this.setBlockWritePointer()
      .then(() => {
        // Enqueue blocks for evaluation
        this.enqueueEvaluateBlockIntervalId = setInterval(() => {
          this.doEnqueueEvaluateBlock()
        }, this.options.enqueueEvaluateBlockIntervalMs!)
      })
      .catch((err: any) => {
        this.logger.warn('setBlockWritePointer() failed. Error:', err.message)
      })
  }

  private async setBlockWritePointer(): Promise<void> {
    this.logger.debug('setBlockWritePointer triggered.')

    try {
      const height = await this.storage!.getHighestBlockMetaHeight()
      this.logger.debug('getBlockMetaCount success. height:', height)
      if (this.options.minHeight && height < this.options.minHeight) {
        this.logger.info(`storage height is smaller than designated minHeight. BlockWritePointer will be set to minHeight [${this.options.minHeight}] instead.`)
        this.blockWritePointer = this.options.minHeight
      } else {
        this.blockWritePointer = height
      }
    } catch (err) {
      this.logger.warn('storage.getBlockMetaCount() failed. Error:', err.message)
      this.logger.info('Assumed that there are no blocks.')
      this.blockWritePointer = this.options.minHeight!
      // Suppress error and continue
    }
  }

  private initBlockVerification() {
    this.logger.debug('initBlockVerification triggered.')
    this.blockVerificationIntervalId = setInterval(() => {
      this.doBlockVerification()
    }, this.options.verifyBlocksIntervalMs!)
  }

  private async doBlockVerification() {
    this.logger.debug('doBlockVerification triggered.')
    this.emit('blockVerification:init')

    // Queue sizes
    this.logger.info('blockQueue.length:', this.blockQueue.length())
    this.logger.info('transactionQueue.length:', this.transactionQueue.length())

    // Check if this process is currently executing
    if (this.isVerifyingBlocks) {
      this.logger.info('doBlockVerification() is already running. Skip this turn.')
      this.emit('blockVerification:complete', { isSkipped: true })
      return
    }

    // Prepare
    this.isVerifyingBlocks = true
    const startHeight = this.options.minHeight!
    const endHeight = this.options.maxHeight && this.blockWritePointer > this.options.maxHeight ? this.options.maxHeight : this.blockWritePointer

    // Act
    let blockMetasFullySynced = false
    let transactionMetasFullySynced = false
    try {
      blockMetasFullySynced = await this.verifyBlockMetas(startHeight, endHeight)
      transactionMetasFullySynced = await this.verifyTransactionMetas(startHeight, endHeight)
    } catch (err) {
      this.logger.info('Block verification failed. Message:', err.message)
      this.isVerifyingBlocks = false
      this.emit('blockVerification:complete', { isSuccess: false })
      return
    }

    // Check if fully sync'ed
    if (this.isReachedMaxHeight()) {
      if (blockMetasFullySynced && transactionMetasFullySynced) {
        this.logger.info('BlockAnalyzer is up to date.')
        this.emit('upToDate')
      }
    }

    // Conclude
    this.isVerifyingBlocks = false
    this.emit('blockVerification:complete', { isSuccess: true })
  }

  private async verifyBlockMetas(startHeight: number, endHeight: number): Promise<boolean> {
    this.logger.debug('verifyBlockMetas triggered.')

    const blockMetaReport = await this.storage!.analyzeBlockMetas(startHeight, endHeight)
    this.logger.debug('Analyzing block metas complete!')

    const all = this.getNumberArray(startHeight, endHeight)

    const availableBlocks: number[] = map(blockMetaReport, (item: any) => item.height)
    this.logger.info('Block metas available count:', availableBlocks.length)

    // Enqueue missing block heights
    const missingBlocks = difference(all, availableBlocks)
    this.logger.info('Block metas missing count:', missingBlocks.length)
    this.emit('blockVerification:blockMetas:missing', { count: missingBlocks.length })
    missingBlocks.forEach((height: number) => {
      this.enqueueEvaluateBlock(height, this.options.missingEvaluateBlockPriority!)
    })

    // Truncate legacy block meta right away
    const legacyBlockObjs = filter(blockMetaReport, (item: any) => {
      return item.apiLevel < this.BLOCK_META_API_LEVEL
    })
    const legacyBlocks = map(legacyBlockObjs, (item: any) => item.height)
    this.logger.info('Legacy block metas count:', legacyBlockObjs.length)
    this.emit('blockVerification:blockMetas:legacy', { count: legacyBlocks.length })
    legacyBlocks.forEach((height: number) => {
      // TODO: use queue instead of unmanaged parallel tasks for removing block metas
      this.storage!.removeBlockMetaByHeight(height)
      this.enqueueEvaluateBlock(height, this.options.legacyEvaluateBlockPriority!)
    })

    const fullySynced = missingBlocks.length === 0 && legacyBlocks.length === 0
    return fullySynced
  }

  private async verifyTransactionMetas(startHeight: number, endHeight: number): Promise<boolean> {
    this.logger.debug('verifyTransactionMetas triggered.')
    // TODO; add capability for detecting missing transaction metas

    const legacyCount = await this.storage!.countLegacyTransactionMeta(this.TRANSACTION_META_API_LEVEL)
    this.emit('blockVerification:transactionMetas:legacy', { metaCount: legacyCount })
    if (legacyCount === 0) {
      return true
    }

    await this.storage!.pruneLegacyTransactionMeta(this.TRANSACTION_META_API_LEVEL)
    return false
  }

  private doEnqueueEvaluateBlock() {
    this.logger.debug('doEnqueueEvaluateBlock triggered.')

    if (this.isReachedMaxHeight()) {
      this.logger.info(`BlockWritePointer is greater or equal to designated maxHeight [${this.options.maxHeight}]. There will be no enqueue block beyond this point.`)
      return
    }

    while (!this.isReachedMaxHeight() && !this.isReachedMaxQueueLength()) {
      this.increaseBlockWritePointer()
      this.enqueueEvaluateBlock(this.blockWritePointer!, this.options.standardEvaluateBlockPriority!)
    }
  }

  private isReachedMaxHeight(): boolean {
    return !!(this.options.maxHeight && this.blockWritePointer >= this.options.maxHeight)
  }

  private isReachedMaxQueueLength(): boolean {
    return this.blockQueue.length() >= this.options.maxBlockQueueLength!
  }

  private increaseBlockWritePointer() {
    this.logger.debug('increaseBlockWritePointer triggered.')
    this.blockWritePointer += 1
  }

  /**
   * @param priority Lower value, the higher its priority to be executed.
   */
  private enqueueEvaluateBlock(height: number, priority: number) {
    this.logger.debug('enqueueEvaluateBlock triggered. height:', height, 'priority:', priority)

    // if the block height is above the current height, increment the write pointer.
    if (height > this.blockWritePointer) {
      this.logger.debug('height > this.blockWritePointer, blockWritePointer is now:', height)
      this.blockWritePointer = height
    }

    this.blockQueue.push(
      {
        method: this.evaluateBlock.bind(this),
        attrs: {
          height,
        },
        meta: {
          methodName: 'evaluateBlock',
        },
      },
      priority
    )
  }

  private async evaluateBlock(attrs: object): Promise<any> {
    this.logger.debug('evaluateBlock triggered. attrs:', attrs)

    const height: number = (attrs as any).height
    let previousBlock: object | undefined
    if (height > 1) {
      previousBlock = await this.storage!.getBlock(height - 1)
    }

    const block: any = await this.storage!.getBlock(height)
    const blockMeta = {
      height,
      time: block.time,
      size: block.size,
      generationTime: BlockHelper.getGenerationTime(block, previousBlock),
      transactionCount: BlockHelper.getTransactionCount(block),
      apiLevel: this.BLOCK_META_API_LEVEL,
    }

    if (this.options.toEvaluateTransactions) {
      this.enqueueEvaluateTransaction(block, this.options.standardEvaluateTransactionPriority!)
    }

    await this.storage!.setBlockMeta(blockMeta)
  }

  private enqueueEvaluateTransaction(block: any, priority: number) {
    this.logger.debug('enqueueEvaluateTransaction triggered.')

    if (!block || !block.tx) {
      this.logger.info('Invalid block object. Skipping...')
      return
    }

    block.tx.forEach((transaction: any) => {
      this.transactionQueue.push(
        {
          method: this.evaluateTransaction.bind(this),
          attrs: {
            height: block.index,
            time: block.time,
            transaction,
          },
          meta: {
            methodName: 'evaluateTransaction',
          },
        },
        priority
      )
    })
  }

  private async enqueueEvaluateTransactionWithHeight(height: number, priority: number) {
    this.logger.debug('enqueueEvaluateTransactionWithHeight triggered.')

    const block: any = await this.storage!.getBlock(height)
    this.enqueueEvaluateTransaction(block, priority)
  }

  private async evaluateTransaction(attrs: object): Promise<any> {
    this.logger.debug('evaluateTransaction triggered.')

    const height: number = (attrs as any).height
    const time: number = (attrs as any).time
    const tx: any = (attrs as any).transaction
    const voutCount: number | undefined = isArray(tx.vout) ? tx.vout.length : undefined
    const vinCount: number | undefined = isArray(tx.vin) ? tx.vin.length : undefined
    const transactionMeta = {
      height,
      time,
      transactionId: tx.txid,
      type: tx.type,
      size: tx.size,
      networkFee: tx.net_fee,
      systemFee: tx.sys_fee,
      voutCount,
      vinCount,
      apiLevel: this.TRANSACTION_META_API_LEVEL,
    }

    await this.storage!.setTransactionMeta(transactionMeta)
  }

  private getNumberArray(start: number, end: number): number[] {
    const all: number[] = []
    for (let i = start; i <= end; i++) {
      all.push(i)
    }
    return all
  }
}
