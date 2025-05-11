import { BaseVectorDatabase, ExtractChunkData, InsertChunkData } from '@llm-tools/embedjs-interfaces';
export declare class MongoDb implements BaseVectorDatabase {
    private readonly debug;
    private static readonly DEFAULT_DB_NAME;
    private static readonly COLLECTION_NAME;
    private static readonly VECTOR_FIELD_NAME;
    private static readonly LOADER_FIELD_NAME;
    private static readonly UNIQUE_FIELD_NAME;
    private static readonly INDEX_PREFIX;
    private readonly client;
    private readonly dbName;
    private collection;
    private readonly collectionName;
    constructor({ connectionString, dbName, collectionName, }: {
        connectionString: string;
        dbName?: string;
        collectionName?: string;
    });
    private getIndexName;
    init({ dimensions }: {
        dimensions: number;
    }): Promise<void>;
    insertChunks(chunks: InsertChunkData[]): Promise<number>;
    similaritySearch(query: number[], k: number): Promise<ExtractChunkData[]>;
    getVectorCount(): Promise<number>;
    deleteKeys(uniqueLoaderId: string): Promise<boolean>;
    reset(): Promise<void>;
}
