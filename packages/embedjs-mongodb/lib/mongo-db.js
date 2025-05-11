import { MongoClient } from 'mongodb';
import createDebugMessages from 'debug';
export class MongoDb {
    debug = createDebugMessages('embedjs:vector:MongoDb');
    static DEFAULT_DB_NAME = 'embedjs';
    static COLLECTION_NAME = 'vectors';
    static VECTOR_FIELD_NAME = 'v_fld';
    static LOADER_FIELD_NAME = 'l_fld';
    static UNIQUE_FIELD_NAME = 'u_fld';
    static INDEX_PREFIX = 'index_';
    client;
    dbName;
    collection;
    collectionName;
    constructor({ connectionString, dbName, collectionName, }) {
        this.collectionName = collectionName ?? MongoDb.COLLECTION_NAME;
        this.dbName = dbName ?? MongoDb.DEFAULT_DB_NAME;
        this.client = new MongoClient(connectionString);
    }
    getIndexName(indexName) {
        return MongoDb.INDEX_PREFIX + indexName;
    }
    async init({ dimensions }) {
        this.debug('Connecting to database');
        await this.client.connect();
        const database = this.client.db(this.dbName);
        this.debug('Connected');
        const collections = await database.collections({ nameOnly: true, authorizedCollections: true });
        if (!collections.some((x) => x.collectionName === this.collectionName)) {
            this.debug(`Creating collection '${this.collectionName}'`);
            await database.createCollection(this.collectionName);
        }
        this.collection = database.collection(this.collectionName);
        this.debug('Collection reference obtained');
        const vectorIndexName = this.getIndexName(MongoDb.VECTOR_FIELD_NAME);
        if ((await this.collection.listSearchIndexes(vectorIndexName).toArray()).length === 0) {
            this.debug(`Creating vector search index '${vectorIndexName}'`);
            await this.collection.createSearchIndex({
                name: vectorIndexName,
                type: 'vectorSearch',
                definition: {
                    fields: [
                        {
                            type: 'vector',
                            numDimensions: dimensions,
                            path: MongoDb.VECTOR_FIELD_NAME,
                            similarity: 'cosine',
                        },
                    ],
                },
            });
        }
        const loaderIndexName = this.getIndexName(MongoDb.LOADER_FIELD_NAME);
        if (!(((await this.collection.indexExists(loaderIndexName)) ||
            (await this.collection.indexExists(`${loaderIndexName}_1`))) //MongoDB atlas sometimes appends _1 to index names
        )) {
            this.debug(`Creating unique loader index '${loaderIndexName}'`);
            await this.collection.createIndex({ [loaderIndexName]: 1 });
        }
        this.debug('All indexes created / exist already');
    }
    async insertChunks(chunks) {
        this.debug(`Inserting ${chunks.length} chunks`);
        const insertResult = await this.collection.insertMany(chunks.map((chunk) => {
            const metadata = chunk.metadata;
            const uniqueLoaderId = metadata.uniqueLoaderId;
            delete metadata.uniqueLoaderId;
            const source = metadata.source;
            delete metadata.source;
            const id = metadata.id;
            delete metadata.id;
            return {
                [MongoDb.UNIQUE_FIELD_NAME]: id,
                [MongoDb.VECTOR_FIELD_NAME]: chunk.vector,
                [MongoDb.LOADER_FIELD_NAME]: uniqueLoaderId,
                pageContent: chunk.pageContent,
                source: source,
                metadata,
            };
        }));
        return insertResult.insertedCount;
    }
    async similaritySearch(query, k) {
        this.debug(`Searching with query dimension ${query.length}`);
        return (await this.collection
            .aggregate([
            {
                $vectorSearch: {
                    index: this.getIndexName(MongoDb.VECTOR_FIELD_NAME),
                    path: MongoDb.VECTOR_FIELD_NAME,
                    numCandidates: 25 * k,
                    queryVector: query,
                    limit: k,
                },
            },
            {
                $project: {
                    _id: 0,
                    source: 1,
                    metadata: 1,
                    pageContent: 1,
                    [MongoDb.UNIQUE_FIELD_NAME]: 1,
                    [MongoDb.LOADER_FIELD_NAME]: 1,
                    score: {
                        $meta: 'vectorSearchScore',
                    },
                },
            },
        ])
            .toArray()).map((row) => {
            return {
                score: row.score,
                pageContent: row.pageContent,
                metadata: {
                    ...row.metadata,
                    source: row.source,
                    id: row[MongoDb.UNIQUE_FIELD_NAME],
                    uniqueLoaderId: row[MongoDb.LOADER_FIELD_NAME],
                },
            };
        });
    }
    async getVectorCount() {
        return this.collection.countDocuments();
    }
    async deleteKeys(uniqueLoaderId) {
        this.debug(`Deleting keys tied to loader '${uniqueLoaderId}'`);
        const result = await this.collection.deleteMany({ [MongoDb.LOADER_FIELD_NAME]: uniqueLoaderId });
        return !!result.deletedCount;
    }
    async reset() {
        await this.collection.deleteMany({});
    }
}
//# sourceMappingURL=mongo-db.js.map