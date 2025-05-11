#!/usr/bin/env node

import { RAGApplicationBuilder, SIMPLE_MODELS } from '@llm-tools/embedjs';
import { OpenAiEmbeddings } from '@llm-tools/embedjs-openai';
import { QdrantDb } from '@llm-tools/embedjs-qdrant';
import { MongoStore } from '@llm-tools/embedjs-mongodb';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { networkInterfaces } from 'os';
import { initDatabase, getProductsBySKUs, closeDatabase } from './db.mjs';

// Load environment variables
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), './.env') });

// Load configurations
let appConfig, promptConfig;

try {
  const appConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config/app.json');
  const appConfigContent = fs.readFileSync(appConfigPath, 'utf8');
  appConfig = JSON.parse(appConfigContent);
  console.log("App configuration loaded from config/app.json");
  
  const promptConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config/prompts.json');
  const promptConfigContent = fs.readFileSync(promptConfigPath, 'utf8');
  promptConfig = JSON.parse(promptConfigContent);
  console.log("Prompt configuration loaded from config/prompts.json");
} catch (error) {
  console.error("Error loading configuration:", error.message);
  process.exit(1);
}

// Configuration
const PORT = process.env.PORT || appConfig.server.port;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SEARCH_RESULT_COUNT = parseInt(process.env.SEARCH_RESULT_COUNT || appConfig.rag.searchResultCount, 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || appConfig.rag.temperature);
const EMBEDDING_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || appConfig.rag.embeddingBatchSize, 10);

// Qdrant Configuration
const QDRANT_HOST = process.env.QDRANT_HOST;
const QDRANT_HTTP_PORT = parseInt(process.env.QDRANT_HTTP_PORT, 10);
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'product_embeddings';

// MongoDB Store Configuration Names (used by MongoStore)
const MONGO_DATABASE_STORE = process.env.MONGO_DATABASE || 'product_db'; // DB for MongoStore
const MONGO_COLLECTION_CONVERSATIONS = process.env.MONGO_COLLECTION_CONVERSATIONS || 'rag_conversations';
const MONGO_COLLECTION_MEMORIES_AS_CUSTOM_DATA = process.env.MONGO_COLLECTION_MEMORIES || 'rag_memories'; // Assuming memories map to customData
const MONGO_COLLECTION_CACHE = process.env.MONGO_COLLECTION_CACHE || 'rag_cache';

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is required');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

let ragApplication = null;
let mongoStore = null;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Helper function to generate a consistent cache key
function generateCacheKey(userId, query, userMetadata) {
    const metadataString = JSON.stringify(userMetadata || {});
    return `cache:${userId}:${query}:${metadataString}`; 
}

async function handleQuery(req, res, endpointName) {
    console.log(`[${endpointName}] Request received for user: ${req.body.userId || 'default_user'}`);
    const userQuery = req.body.query || req.body.question;
    const user = req.body.user || {};
    const userId = user.id || req.body.userId || req.query.userId || 'default_user';
    const userName = user.name || '';
    const children = user.children || [];

    if (!userQuery) {
        console.log(`[${endpointName}] Query is missing.`);
        return res.status(400).json({ answer: "Query is required.", relatedProducts: [] });
    }

    if (!ragApplication || !promptConfig || !mongoStore) {
        console.error(`[${endpointName}] Critical component not initialized: RAG: ${!!ragApplication}, PromptConfig: ${!!promptConfig}, MongoStore: ${!!mongoStore}`);
        return res.status(503).json({
            answer: `RAG system, prompt configuration, or MongoStore not initialized yet for ${endpointName}`,
            relatedProducts: []
        });
    }

    try {
        // 1. Cache Handling
        const userMetadataForCacheKey = { name: userName, children };
        const cacheKey = generateCacheKey(userId, userQuery, userMetadataForCacheKey);
        let cachedResultDocument = null;

        try {
            console.log(`[${endpointName}] Attempting to get cache with key: ${cacheKey}`);
            cachedResultDocument = await mongoStore.loaderCustomGet(cacheKey); // Assumes this method is safe for cache misses after library fix or workaround
        } catch (cacheGetError) {
            console.warn(`[${endpointName}] Error during mongoStore.loaderCustomGet for cache (treating as cache miss): ${cacheGetError.message}`);
        }

        if (cachedResultDocument && cachedResultDocument.data) { // Check for .data property
            console.log(`[${endpointName}] MongoStore cache hit for query: "${userQuery.substring(0, 30)}..." by user ${userId}`);
            return res.json(cachedResultDocument.data);
        }
        if (!cachedResultDocument || !cachedResultDocument.data) {
             console.log(`[${endpointName}] Cache miss for key (or error during fetch/no data property): ${cacheKey}`);
        }

        // 2. Memory Retrieval (Restored - gets the last summary)
        let longTermMemoryContext = "";
        const memoryKeyForLastSummary = `memory:${userId}:last_summary`; 
        console.log(`[${endpointName}] Attempting to get last summary memory with key: ${memoryKeyForLastSummary}`);
        try {
            const lastSummaryMemory = await mongoStore.loaderCustomGet(memoryKeyForLastSummary);
            if (lastSummaryMemory && lastSummaryMemory.text) { // Assuming memory is stored with a .text property
                longTermMemoryContext = lastSummaryMemory.text;
                console.log(`[${endpointName}] Retrieved last summary for longTermMemoryContext.`);
            } else {
                console.log(`[${endpointName}] No last summary found or no text in memory for longTermMemoryContext.`);
            }
        } catch (memoryGetError) {
            console.warn(`[${endpointName}] Error during mongoStore.loaderCustomGet for memory (treating as no memory): ${memoryGetError.message}`);
        }

        const { systemPreamble, answerFieldDetails, relatedProductsFieldDetails, closingInstruction } = promptConfig.jsonOutputInstructions;
        let promptForRAG = `${systemPreamble}\n\n${answerFieldDetails}\n\n${relatedProductsFieldDetails}\n\n`;

        if (userName || (children && children.length > 0)) {
            promptForRAG += `User profile:\n`;
            if (userName) promptForRAG += `- Name: ${userName}\n`;
            if (children.length > 0) {
                promptForRAG += `- Children:\n`;
                for (const child of children) {
                    promptForRAG += `  - Name: ${child.name || ''}, Age: ${child.age || ''}, Gender: ${child.gender || ''}, Birthday: ${child.birthday || ''}\n`;
                }
            }
            promptForRAG += '\n';
        }

        if (longTermMemoryContext && longTermMemoryContext.trim() !== "") { 
            promptForRAG += `Relevant past information for ${userId}:\n${longTermMemoryContext}\n\n`;
        }

        // 3. Conversation History
        console.log(`[${endpointName}] Checking conversation history for conversationId: ${userId}`);
        let conversationData = null;
        const conversationExists = await mongoStore.hasConversation(userId);

        if (conversationExists) {
            console.log(`[${endpointName}] Existing conversation found for ${userId}. Fetching...`);
            conversationData = await mongoStore.getConversation(userId); 
        } else {
            console.log(`[${endpointName}] No existing conversation found for ${userId}. Creating new one.`);
            if (typeof mongoStore.addConversation === 'function') {
                 await mongoStore.addConversation(userId); 
                 conversationData = await mongoStore.getConversation(userId); 
                 if (!conversationData) {
                    console.error(`[${endpointName}] Failed to retrieve conversation immediately after adding for ${userId}. Initializing locally.`);
                    conversationData = { conversationId: userId, entries: [] }; 
                 }
            } else {
                console.error(`[${endpointName}] mongoStore.addConversation is not a function! Cannot create new conversation.`);
                conversationData = { conversationId: userId, entries: [] };
            }
        }
        
        const currentEntries = (conversationData && conversationData.entries) ? conversationData.entries : [];
        const limitedHistoryEntries = currentEntries.slice(-10);
        const shortTermHistoryText = limitedHistoryEntries.map(turn => `${turn.role}: ${turn.content}`).join("\n");
        if (shortTermHistoryText) {
            promptForRAG += `Current conversation history:\n${shortTermHistoryText}\n\n`;
        }

        promptForRAG += `User's current query: ${userQuery}\n\n${closingInstruction}`;
        console.log(`[${endpointName}] --- Prompt sent to LLM ---\n${promptForRAG}\n-----------------------------------`);

        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out after 15 seconds')), 15000));
        const result = await Promise.race([ragApplication.query(promptForRAG), timeout]);

        console.log(`[${endpointName}] --- Complete RAG result object ---\n${JSON.stringify(result, null, 2)}\n----------------------------------`);
        let llmOutputString = result.answer || result.content || result.text || result.response || '';
        console.log(`[${endpointName}] --- LLM Raw Output (extracted) ---\n${llmOutputString}\n---------------------------------------------------`);

        let botResponseJson;
        try {
            if (typeof llmOutputString !== 'string' || llmOutputString.trim() === "") {
                throw new Error("LLM output is not a non-empty string, cannot parse.");
            }
            let cleanedOutput = llmOutputString;
            if (llmOutputString.includes("```")) {
                const codeBlockMatch = llmOutputString.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (codeBlockMatch && codeBlockMatch[1]) cleanedOutput = codeBlockMatch[1].trim();
            }
            botResponseJson = JSON.parse(cleanedOutput);

            if (typeof botResponseJson.answer !== 'string' || !Array.isArray(botResponseJson.relatedProducts)) {
                throw new Error("LLM output is not in the expected {answer: string, relatedProducts: array} format.");
            }
            botResponseJson.relatedProducts = botResponseJson.relatedProducts.map(sku => typeof sku === 'string' ? sku : String(sku));
            
            const productDetails = await getProductsBySKUs(botResponseJson.relatedProducts);
            botResponseJson.relatedProducts = productDetails;

        } catch (e) {
            console.error(`[${endpointName}] Failed to parse LLM response or structure was invalid: ${e.message}. LLM Raw: ${llmOutputString}`);
            botResponseJson = { 
                answer: `I had a little trouble formatting my response perfectly. Here's the main information: ${llmOutputString || "Not available"}`,
                relatedProducts: [] 
            };
        }

        const isValidResponse = botResponseJson && typeof botResponseJson.answer === 'string' && botResponseJson.answer.trim() !== '' && !botResponseJson.answer.includes('I had a little trouble formatting my response');

        if (isValidResponse) {
            if (typeof mongoStore.addEntryToConversation === 'function') {
                console.log(`[${endpointName}] Adding user turn to conversation ${userId}`);
                await mongoStore.addEntryToConversation(userId, { role: 'User', content: userQuery, timestamp: new Date() });
                console.log(`[${endpointName}] Adding bot turn to conversation ${userId}`);
                await mongoStore.addEntryToConversation(userId, { role: 'Bot', content: botResponseJson.answer, timestamp: new Date() });
            } else {
                 console.error(`[${endpointName}] mongoStore.addEntryToConversation is not a function! Cannot save conversation turns.`);
            }
            
            // Caching (using corrected loaderCustomSet from your local package if fix was applied)
            if (typeof mongoStore.loaderCustomSet === 'function') {
                console.log(`[${endpointName}] Setting cache with key: ${cacheKey}`);
                await mongoStore.loaderCustomSet(userId, cacheKey, { data: botResponseJson, timestamp: new Date() }); 
            } else {
                console.error(`[${endpointName}] mongoStore.loaderCustomSet is not a function! Cannot save to cache.`);
            }
        }

        // Summarization and Memory Storage (Restored)
        const updatedConvDataForSummary = await mongoStore.getConversation(userId); 
        const freshHistoryEntries = updatedConvDataForSummary && updatedConvDataForSummary.entries ? updatedConvDataForSummary.entries : [];

        if (freshHistoryEntries.length > 0 && freshHistoryEntries.length % 10 === 0) { 
            const historyTextForSummary = freshHistoryEntries.map(turn => `${turn.role}: ${turn.content}`).join("\n");
            console.log(`[${endpointName}] Summarizing conversation for ${userId}`);
            const summary = await summarizeConversation(userId, historyTextForSummary);
            if (summary && !summary.startsWith("Error") && !summary.startsWith("Could not summarize")){
                // const memoryKeyForLastSummary = `memory:${userId}:last_summary`; // Already defined above
                if (typeof mongoStore.loaderCustomSet === 'function') {
                    console.log(`[${endpointName}] Adding memory (summary) for ${userId} with key: ${memoryKeyForLastSummary}`);
                    await mongoStore.loaderCustomSet(userId, memoryKeyForLastSummary, { text: summary, type: 'conversation_summary', timestamp: new Date() });
                } else {
                    console.error(`[${endpointName}] mongoStore.loaderCustomSet is not a function! Cannot save memory (summary).`);
                }
            }
        }
        // console.log(`[${endpointName}] Summarization and memory storage logic was processed.`); // Optional log for verbosity
            
        res.json(botResponseJson);

    } catch (error) {
        console.error(`[${endpointName}] Error processing question:`, error);
        res.status(500).json({ 
            answer: 'Error processing your question', 
            relatedProducts: [],
            details: error.message 
        });
    }
}

app.post('/ask', (req, res) => handleQuery(req, res, '/ask'));
app.post('/chat', (req, res) => handleQuery(req, res, '/chat'));

async function initializeApp() {
    console.log("Initializing Product Database (MongoDB)...");
    const productDbInitialized = await initDatabase(); 
    if (!productDbInitialized) {
        console.error("FATAL ERROR: Could not initialize Product Database (MongoDB). Exiting.");
        process.exit(1);
    }
    
    try {
        console.log("Initializing MongoStore for RAG data...");
        
        const MONGO_STORE_CONNECTION_URI_FROM_ENV = process.env.MONGO_STORE_CONNECTION_URI;

        if (!MONGO_STORE_CONNECTION_URI_FROM_ENV || MONGO_STORE_CONNECTION_URI_FROM_ENV.trim() === "") {
            console.error("CRITICAL: MONGO_STORE_CONNECTION_URI is not set in the environment. This is required for MongoStore.");
            throw new Error("MONGO_STORE_CONNECTION_URI is not set. Cannot initialize MongoStore.");
        }

        const storeConfigForMongoStore = {
            uri: MONGO_STORE_CONNECTION_URI_FROM_ENV, // Corrected property name
            dbName: MONGO_DATABASE_STORE,
            cacheCollectionName: MONGO_COLLECTION_CACHE,
            customDataCollectionName: MONGO_COLLECTION_MEMORIES_AS_CUSTOM_DATA, // Map memories to customData collection
            conversationCollectionName: MONGO_COLLECTION_CONVERSATIONS
        };
        
        console.log(`MongoStore will use connection URI: ${MONGO_STORE_CONNECTION_URI_FROM_ENV.substring(0, MONGO_STORE_CONNECTION_URI_FROM_ENV.indexOf('@') > 0 ? MONGO_STORE_CONNECTION_URI_FROM_ENV.indexOf(':', MONGO_STORE_CONNECTION_URI_FROM_ENV.indexOf('//')+2)+1 : 30)}...`);
        console.log("MongoStore config being passed to constructor:", JSON.stringify(storeConfigForMongoStore));

        mongoStore = new MongoStore(storeConfigForMongoStore); 
        
        // MongoStore source shows init() is async and creates client, so await is correct.
        if (typeof mongoStore.init === 'function') { 
            console.log("Attempting to call mongoStore.init()...");
            await mongoStore.init(); 
        }
        console.log("MongoStore initialized successfully.");

    } catch (error) {
        console.error("FATAL ERROR: Could not initialize MongoStore for RAG data. Exiting.", error);
        process.exit(1);
    }

    try {
        // Construct the Qdrant URL
        const qdrantUrl = `http://${QDRANT_HOST}:${QDRANT_HTTP_PORT}`;
        console.log(`Connecting RAG to Qdrant: URL: '${qdrantUrl}', Collection (ClusterName): '${QDRANT_COLLECTION_NAME}'`);
        console.log(`Configuring RAG with: Search Results: ${SEARCH_RESULT_COUNT}, Temperature: ${TEMPERATURE}, Embedding Batch Size: ${EMBEDDING_BATCH_SIZE}`);
        
        // Log Qdrant connection parameters just before use (apiKey is optional)
        console.log(`QdrantDb PRE-INIT: URL: '${qdrantUrl}', API Key: '${QDRANT_API_KEY ? "Exists" : "Not Set"}', ClusterName: '${QDRANT_COLLECTION_NAME}'`);

        ragApplication = await new RAGApplicationBuilder()
            .setEmbeddingModel(new OpenAiEmbeddings({
                apiKey: OPENAI_API_KEY, 
                batchSize: EMBEDDING_BATCH_SIZE 
            }))
            .setModel(SIMPLE_MODELS.OPENAI_GPT4_O) 
            .setVectorDatabase(new QdrantDb({
              url: qdrantUrl,                     // Correct: Pass the full URL
              apiKey: QDRANT_API_KEY,             // Correct: Pass apiKey directly (it's optional)
              clusterName: QDRANT_COLLECTION_NAME // Correct: Use clusterName for the collection
              // Note: checkCompatibility is not a parameter for this QdrantDb constructor
            })) 
            .setStore(mongoStore) 
            .setTemperature(TEMPERATURE)
            .setSearchResultCount(SEARCH_RESULT_COUNT)
            .build();
        console.log("RAG Application initialized successfully (including MongoStore and QdrantDb).");
    } catch (error) {
        console.error("FATAL ERROR: Could not initialize RAG Application. Exiting.", error);
        console.error('Ensure Qdrant & MongoStore are running and accessible, and embeddings are generated.');
        process.exit(1);
    }
}

async function summarizeConversation(userId, conversationHistoryText) {
    if (!ragApplication || !promptConfig || !promptConfig.summarizationInstruction) {
        console.error("Summarization prompt not found in config or RAG app not ready.");
        return "Could not summarize due to configuration issue.";
    }
    
    let promptTemplate = promptConfig.summarizationInstruction;
    const filledPrompt = promptTemplate
        .replace('{{userId}}', userId)
        .replace('{{conversationHistoryText}}', conversationHistoryText);

    try {
        const result = await ragApplication.query(filledPrompt);
        const summary = result.answer || result.content || result.text || result.response || '';
        return summary;
    } catch (e) {
        console.error("Error during summarization LLM call:", e);
        return "Error performing summarization.";
    }
}

function getNetworkIPs() {
  const nets = networkInterfaces();
  const results = {};
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        if (!results[name]) results[name] = [];
        results[name].push(net.address);
      }
    }
  }
  return results;
}

process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (mongoStore && typeof mongoStore.close === 'function') {
        await mongoStore.close();
        console.log('MongoStore connection closed.');
    }
    await closeDatabase();
    process.exit(0);
});

initializeApp().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}. RAG App, Prompts, Product DB, and MongoStore Initialized.`);
        console.log(`Local URL: http://localhost:${PORT}`);
        const networkIPs = getNetworkIPs();
        if (Object.keys(networkIPs).length > 0) {
            console.log('Network URLs:');
            for (const [interfaceName, addresses] of Object.entries(networkIPs)) {
                for (const ip of addresses) {
                    console.log(`  http://${ip}:${PORT} (${interfaceName})`);
                }
            }
        } else {
            console.log('No network interfaces detected.');
        }
    });
}).catch(initializationError => {
    console.error("Application failed to initialize:", initializationError);
    process.exit(1);
}); 