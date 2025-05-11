import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

// Load configurations
let appConfig, promptConfig;

try {
  const appConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../config/app.json');
  const appConfigContent = fs.readFileSync(appConfigPath, 'utf8');
  appConfig = JSON.parse(appConfigContent);
  console.log("App configuration loaded from config/app.json");
  
  const promptConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../config/prompts.json');
  const promptConfigContent = fs.readFileSync(promptConfigPath, 'utf8');
  promptConfig = JSON.parse(promptConfigContent);
  console.log("Prompt configuration loaded from config/prompts.json");
} catch (error) {
  console.error("Error loading configuration:", error.message);
  process.exit(1);
}

// Configuration
const config = {
  server: {
    port: process.env.PORT || appConfig.server.port,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  rag: {
    searchResultCount: parseInt(process.env.SEARCH_RESULT_COUNT || appConfig.rag.searchResultCount, 10),
    temperature: parseFloat(process.env.TEMPERATURE || appConfig.rag.temperature),
    embeddingBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || appConfig.rag.embeddingBatchSize, 10),
  },
  qdrant: {
    host: process.env.QDRANT_HOST,
    httpPort: parseInt(process.env.QDRANT_HTTP_PORT, 10),
    apiKey: process.env.QDRANT_API_KEY,
    collectionName: process.env.QDRANT_COLLECTION_NAME || 'product_embeddings',
  },
  mongo: {
    host: process.env.MONGO_HOST,
    port: process.env.MONGO_PORT,
    username: process.env.MONGO_INITDB_ROOT_USERNAME,
    password: process.env.MONGO_INITDB_ROOT_PASSWORD,
    database: process.env.MONGO_DATABASE || 'product_db',
    storeConnectionUri: process.env.MONGO_STORE_CONNECTION_URI,
    collections: {
      conversations: process.env.MONGO_COLLECTION_CONVERSATIONS || 'rag_conversations',
      memories: process.env.MONGO_COLLECTION_MEMORIES || 'rag_memories',
      cache: process.env.MONGO_COLLECTION_CACHE || 'rag_cache',
      products: process.env.MONGO_COLLECTION_PRODUCTS || 'products',
    }
  }
};

export { config, appConfig, promptConfig }; 