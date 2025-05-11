import { RAGApplicationBuilder, SIMPLE_MODELS } from '@llm-tools/embedjs';
import { OpenAiEmbeddings } from '@llm-tools/embedjs-openai';
import { QdrantDb } from '@llm-tools/embedjs-qdrant';
import { MongoStore } from '@llm-tools/embedjs-mongodb';
import { config } from '../config/index.js';

class RagService {
  constructor() {
    this.ragApplication = null;
    this.mongoStore = null;
  }

  async initialize() {
    try {
      console.log("Initializing MongoStore for RAG data...");
      
      if (!config.mongo.storeConnectionUri || config.mongo.storeConnectionUri.trim() === "") {
        console.error("CRITICAL: MONGO_STORE_CONNECTION_URI is not set in the environment. This is required for MongoStore.");
        throw new Error("MONGO_STORE_CONNECTION_URI is not set. Cannot initialize MongoStore.");
      }

      const storeConfigForMongoStore = {
        uri: config.mongo.storeConnectionUri,
        dbName: config.mongo.database,
        cacheCollectionName: config.mongo.collections.cache,
        customDataCollectionName: config.mongo.collections.memories,
        conversationCollectionName: config.mongo.collections.conversations
      };
      
      console.log(`MongoStore will use connection URI: ${config.mongo.storeConnectionUri.substring(0, config.mongo.storeConnectionUri.indexOf('@') > 0 ? config.mongo.storeConnectionUri.indexOf(':', config.mongo.storeConnectionUri.indexOf('//')+2)+1 : 30)}...`);
      console.log("MongoStore config being passed to constructor:", JSON.stringify(storeConfigForMongoStore));

      this.mongoStore = new MongoStore(storeConfigForMongoStore); 
      
      if (typeof this.mongoStore.init === 'function') { 
        console.log("Attempting to call mongoStore.init()...");
        await this.mongoStore.init(); 
      }
      console.log("MongoStore initialized successfully.");

      // Construct the Qdrant URL
      const qdrantUrl = `http://${config.qdrant.host}:${config.qdrant.httpPort}`;
      console.log(`Connecting RAG to Qdrant: URL: '${qdrantUrl}', Collection (ClusterName): '${config.qdrant.collectionName}'`);
      console.log(`Configuring RAG with: Search Results: ${config.rag.searchResultCount}, Temperature: ${config.rag.temperature}, Embedding Batch Size: ${config.rag.embeddingBatchSize}`);
      
      // Log Qdrant connection parameters just before use
      console.log(`QdrantDb PRE-INIT: URL: '${qdrantUrl}', API Key: '${config.qdrant.apiKey ? "Exists" : "Not Set"}', ClusterName: '${config.qdrant.collectionName}'`);

      this.ragApplication = await new RAGApplicationBuilder()
        .setEmbeddingModel(new OpenAiEmbeddings({
          apiKey: config.openai.apiKey, 
          batchSize: config.rag.embeddingBatchSize 
        }))
        .setModel(SIMPLE_MODELS.OPENAI_GPT4_O) 
        .setVectorDatabase(new QdrantDb({
          url: qdrantUrl,
          apiKey: config.qdrant.apiKey,
          clusterName: config.qdrant.collectionName
        })) 
        .setStore(this.mongoStore) 
        .setTemperature(config.rag.temperature)
        .setSearchResultCount(config.rag.searchResultCount)
        .build();
      console.log("RAG Application initialized successfully (including MongoStore and QdrantDb).");
      
      return true;
    } catch (error) {
      console.error("Error initializing RAG service:", error);
      throw error;
    }
  }

  async query(prompt) {
    if (!this.ragApplication) {
      throw new Error("RAG Application not initialized");
    }
    return await this.ragApplication.query(prompt);
  }

  async summarizeConversation(userId, conversationHistoryText, promptTemplate) {
    if (!this.ragApplication) {
      throw new Error("RAG Application not initialized");
    }
    
    const filledPrompt = promptTemplate
      .replace('{{userId}}', userId)
      .replace('{{conversationHistoryText}}', conversationHistoryText);

    try {
      const result = await this.ragApplication.query(filledPrompt);
      const summary = result.answer || result.content || result.text || result.response || '';
      return summary;
    } catch (e) {
      console.error("Error during summarization LLM call:", e);
      return "Error performing summarization.";
    }
  }
  
  async close() {
    if (this.mongoStore && typeof this.mongoStore.close === 'function') {
      await this.mongoStore.close();
      console.log('MongoStore connection closed.');
    }
  }
}

// Singleton instance
const ragService = new RagService();
export default ragService; 