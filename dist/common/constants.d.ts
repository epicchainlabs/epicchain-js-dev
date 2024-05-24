declare const C: {
    network: {
        testnet: string;
        mainnet: string;
    };
    storage: {
        memory: string;
        mongodb: string;
    };
    rpc: {
        getblock: string;
        getblockcount: string;
        getversion: string;
        getrawtransaction: string;
    };
    transaction: {
        MinerTransaction: string;
        ContractTransaction: string;
        InvocationTransaction: string;
        ClaimTransaction: string;
    };
};
export default C;
