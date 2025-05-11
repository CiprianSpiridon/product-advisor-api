import createDebugMessages from 'debug';
import { MongoClient } from 'mongodb';
export class MongoStore {
    debug = createDebugMessages('embedjs:store:MongoCache');
    uri;
    dbName;
    cacheCollectionName;
    metadataCollection;
    customDataCollectionName;
    customDataCollection;
    conversationCollectionName;
    conversationCollection;
    constructor({ uri, dbName, cacheCollectionName = 'cache', customDataCollectionName = 'customData', conversationCollectionName = 'conversations', }) {
        this.uri = uri;
        this.dbName = dbName;
        this.cacheCollectionName = cacheCollectionName;
        this.customDataCollectionName = customDataCollectionName;
        this.conversationCollectionName = conversationCollectionName;
    }
    async init() {
        const client = new MongoClient(this.uri);
        await client.connect();
        // Create index on loaderId field
        this.metadataCollection = client.db(this.dbName).collection(this.cacheCollectionName);
        try {
            await this.metadataCollection.createIndex({ loaderId: 1 }, { unique: true });
        }
        catch {
            this.debug('Index on loaderId already exists on metadataCollection');
        }
        // Create index on loaderId field
        this.customDataCollection = client.db(this.dbName).collection(this.customDataCollectionName);
        try {
            await this.customDataCollection.createIndex({ loaderId: 1 });
        }
        catch {
            this.debug('Index on loaderId already exists on customDataCollection');
        }
        try {
            await this.customDataCollection.createIndex({ key: 1 }, { unique: true });
        }
        catch {
            this.debug('Index on key already exists on customDataCollection');
        }
        // Create index on conversationId field
        this.conversationCollection = client.db(this.dbName).collection(this.conversationCollectionName);
        try {
            await this.conversationCollection.createIndex({ conversationId: 1 }, { unique: true });
        }
        catch {
            this.debug('Index on conversationId already exists on conversationCollection');
        }
        // Create index on entries._id field
        try {
            await this.conversationCollection.createIndex({ 'entries._id': 1 });
        }
        catch {
            this.debug('Index on `entries._id` already exists on conversationCollection');
        }
    }
    async addLoaderMetadata(loaderId, value) {
        await this.metadataCollection.insertOne({ ...value, loaderId });
    }
    async getLoaderMetadata(loaderId) {
        const result = await this.metadataCollection.findOne({ loaderId });
        delete result.loaderId;
        delete result._id;
        return result;
    }
    async hasLoaderMetadata(loaderId) {
        return !!(await this.metadataCollection.findOne({ loaderId }));
    }
    async getAllLoaderMetadata() {
        const result = await this.metadataCollection.find({}).toArray();
        return result.map((entry) => {
            delete entry.loaderId;
            delete entry._id;
            return entry;
        });
    }
    async loaderCustomSet(loaderId, key, value) {
        await this.customDataCollection.updateOne({ key }, { $set: { ...value, key, loaderId } }, { upsert: true });
    }
    async loaderCustomGet(key) {
        const result = await this.customDataCollection.findOne({ key });
        delete result.loaderId;
        delete result.key;
        delete result._id;
        return result;
    }
    async loaderCustomHas(key) {
        return !!(await this.customDataCollection.findOne({ key }));
    }
    async loaderCustomDelete(key) {
        await this.customDataCollection.deleteOne({ key });
    }
    async deleteLoaderMetadataAndCustomValues(loaderId) {
        await this.metadataCollection.deleteOne({ loaderId });
        await this.customDataCollection.deleteMany({ loaderId });
    }
    async addConversation(conversationId) {
        await this.conversationCollection.insertOne({ conversationId, entries: [] });
    }
    async getConversation(conversationId) {
        const document = await this.conversationCollection.findOne({ conversationId });
        return {
            conversationId: document.conversationId,
            entries: document.entries,
        };
    }
    async hasConversation(conversationId) {
        return !!(await this.conversationCollection.findOne({ conversationId }));
    }
    async deleteConversation(conversationId) {
        await this.conversationCollection.deleteOne({ conversationId });
    }
    async addEntryToConversation(conversationId, entry) {
        await this.conversationCollection.updateOne({ conversationId }, { $push: { entries: entry } });
    }
    async clearConversations() {
        await this.conversationCollection.deleteMany({});
    }
}
//# sourceMappingURL=mongo-store.js.map