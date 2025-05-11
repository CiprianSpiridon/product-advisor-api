import { BaseStore, Conversation, LoaderListEntry, Message } from '@llm-tools/embedjs-interfaces';
export declare class MongoStore implements BaseStore {
    private readonly debug;
    private readonly uri;
    private readonly dbName;
    private readonly cacheCollectionName;
    private metadataCollection;
    private readonly customDataCollectionName;
    private customDataCollection;
    private readonly conversationCollectionName;
    private conversationCollection;
    constructor({ uri, dbName, cacheCollectionName, customDataCollectionName, conversationCollectionName, }: {
        uri: string;
        dbName: string;
        cacheCollectionName: string;
        customDataCollectionName: string;
        conversationCollectionName: string;
    });
    init(): Promise<void>;
    addLoaderMetadata(loaderId: string, value: LoaderListEntry): Promise<void>;
    getLoaderMetadata(loaderId: string): Promise<LoaderListEntry>;
    hasLoaderMetadata(loaderId: string): Promise<boolean>;
    getAllLoaderMetadata(): Promise<LoaderListEntry[]>;
    loaderCustomSet<T extends Record<string, unknown>>(loaderId: string, key: string, value: T): Promise<void>;
    loaderCustomGet<T extends Record<string, unknown>>(key: string): Promise<T>;
    loaderCustomHas(key: string): Promise<boolean>;
    loaderCustomDelete(key: string): Promise<void>;
    deleteLoaderMetadataAndCustomValues(loaderId: string): Promise<void>;
    addConversation(conversationId: string): Promise<void>;
    getConversation(conversationId: string): Promise<Conversation>;
    hasConversation(conversationId: string): Promise<boolean>;
    deleteConversation(conversationId: string): Promise<void>;
    addEntryToConversation(conversationId: string, entry: Message): Promise<void>;
    clearConversations(): Promise<void>;
}
