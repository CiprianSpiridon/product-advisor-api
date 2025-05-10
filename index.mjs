#!/usr/bin/env node

import { RAGApplicationBuilder, SIMPLE_MODELS } from '@llm-tools/embedjs';
import { OpenAiEmbeddings } from '@llm-tools/embedjs-openai';
import { CsvLoader } from '@llm-tools/embedjs-loader-csv';
import { LanceDb } from '@llm-tools/embedjs-lancedb';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs'; // For reading the prompt config file
import { networkInterfaces } from 'os'; // Import networkInterfaces from os

// Load environment variables
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), './.env') });

// Load configurations
let appConfig, promptConfig;

try {
  // Load app configuration
  const appConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config/app.json');
  const appConfigContent = fs.readFileSync(appConfigPath, 'utf8');
  appConfig = JSON.parse(appConfigContent);
  console.log("App configuration loaded from config/app.json");
  
  // Load prompt configuration
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
const VECTOR_DB_PATH = appConfig.vectorDb.path;

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is required');
  process.exit(1);
}

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev')); // Logging

// RAG System Configuration
const csvPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../products.csv');
const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectordb');

// Initialize RAG system
let ragApplication = null;

// --- Short-term conversation history (simple in-memory store for demo) ---
const conversationHistories = {}; // { userId: ["User: Hi", "Bot: Hello!"] }

async function initRAG() {
  console.log('Initializing RAG system...');
  console.log('Using pre-generated embeddings from vector database...');
  
  try {
    // Create the RAG application with embedJs
    const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), VECTOR_DB_PATH);
    
    console.log(`Configuring RAG with: Search Results: ${SEARCH_RESULT_COUNT}, Temperature: ${TEMPERATURE}, Embedding Batch Size: ${EMBEDDING_BATCH_SIZE}`);

    ragApplication = await new RAGApplicationBuilder()
      .setEmbeddingModel(new OpenAiEmbeddings({
        apiKey: process.env.OPENAI_API_KEY, 
        batchSize: EMBEDDING_BATCH_SIZE 
      }))
      .setModel(SIMPLE_MODELS.OPENAI_GPT4_O)
      .setVectorDatabase(new LanceDb({ path: dbPath }))
      .setTemperature(TEMPERATURE)
      .setSearchResultCount(SEARCH_RESULT_COUNT)
      .build();
    
    // Skip the CSV loading step as embeddings should be pre-generated
    // using the generate-embeddings.mjs script
    
    console.log('RAG system initialized successfully');
    return true;
  } catch (error) {
    console.error('Error initializing RAG system:', error);
    console.error('Make sure to run generate-embeddings.mjs first to create the vector database');
    return false;
  }
}

// API routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/ask', async (req, res) => {
  // Accept both 'query' and 'question' for backward compatibility
  const userQuery = req.body.query || req.body.question;
  const user = req.body.user || {};
  const userId = user.id || req.body.userId || req.query.userId || 'default_user';
  const userName = user.name || '';
  const children = user.children || [];

  if (!userQuery) {
    return res.status(400).json({ answer: "Query is required.", relatedProducts: [] });
  }

  if (!ragApplication || !promptConfig) {
    return res.status(503).json({
      answer: "RAG system or prompt configuration not initialized yet",
      relatedProducts: []
    });
  }

  if (!conversationHistories[userId]) {
    conversationHistories[userId] = [];
  }

  // Construct the prompt using loaded config (same logic as /chat)
  const longTermMemoryContext = await retrieveMemories(userId, userQuery);
  const { systemPreamble, answerFieldDetails, relatedProductsFieldDetails, closingInstruction } = promptConfig.jsonOutputInstructions;
  
  let promptForRAG = `${systemPreamble}\n\n${answerFieldDetails}\n\n${relatedProductsFieldDetails}\n\n`;

  // Inject user metadata
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

  if (longTermMemoryContext) {
      promptForRAG += `Relevant past information for ${userId}:\n${longTermMemoryContext}\n\n`;
  }

  const shortTermHistoryText = conversationHistories[userId].join("\n");
  if (shortTermHistoryText) {
      promptForRAG += `Current conversation history:\n${shortTermHistoryText}\n\n`;
  }

  promptForRAG += `User's current query: ${userQuery}\n\n${closingInstruction}`;

  // Log the prompt sent to the model
  console.log("--- Prompt sent to LLM (/ask): ---");
  console.log(promptForRAG);
  console.log("-----------------------------------");

  console.log(`Processing augmented query for user ${userId} in /ask endpoint...`);
  // console.log("Prompt for RAG (/ask):", promptForRAG); // For debugging

  try {
    const result = await ragApplication.query(promptForRAG);
    // Log the complete result object for debugging
    console.log("--- Complete RAG result object (/ask): ---");
    console.log(JSON.stringify(result, null, 2));
    console.log("----------------------------------");
    
    // Extract the LLM output from the result object
    let llmOutputString = result.answer || result.content || result.text || result.response || '';

    // Log the direct output from the LLM for debugging
    console.log("--- /ask endpoint: LLM Raw Output (extracted) ---");
    console.log(llmOutputString);
    console.log("---------------------------------------------------");

    let botResponseJson;
    try {
        if (typeof llmOutputString !== 'string' || llmOutputString.trim() === "") {
            console.error("/ask: LLM output (result.answer) is not a non-empty string. Value:", llmOutputString);
            throw new Error("LLM output is not a non-empty string, cannot parse.");
        }
        
        // Clean the output string if it contains markdown code fences
        let cleanedOutput = llmOutputString;
        if (llmOutputString.includes("```")) {
            // Extract content from between code fences (```json ... ```)
            const codeBlockMatch = llmOutputString.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (codeBlockMatch && codeBlockMatch[1]) {
                cleanedOutput = codeBlockMatch[1].trim();
            }
        }
        
        botResponseJson = JSON.parse(cleanedOutput);

        // Validate the structure: answer (string) and relatedProducts (array of objects)
        if (typeof botResponseJson.answer !== 'string' || !Array.isArray(botResponseJson.relatedProducts)) {
            console.warn("/ask: LLM output was valid JSON but not the expected top-level structure. LLM Raw:", llmOutputString);
            throw new Error("LLM output is not in the expected {answer: string, relatedProducts: array} format.");
        }

        // Validate each item in relatedProducts
        for (const item of botResponseJson.relatedProducts) {
            if (typeof item !== 'object' || item === null ||
                typeof item.sku !== 'string' ||
                typeof item.name !== 'string' ||
                typeof item.description !== 'string') {
                console.warn("/ask: An item in relatedProducts has an invalid structure. Item:", item, "LLM Raw:", llmOutputString);
                throw new Error("An item in relatedProducts does not have the required {sku: string, name: string, description: string} structure.");
            }
            
            // Ensure all expected fields exist (add missing ones as empty strings or null)
            const expectedFields = ['brand_default_store', 'features', 'recom_age', 'top_category', 'secondary_category', 'action', 'url', 'image', 'objectID'];
            for (const field of expectedFields) {
                if (typeof item[field] !== 'string') {
                    item[field] = item[field] !== undefined ? String(item[field]) : ''; // Convert to string or use empty string
                }
            }
        }
    } catch (e) {
        console.error("/ask: Failed to parse LLM response as JSON or structure was invalid:", e.message);
        // console.error("/ask: LLM raw output was:", llmOutputString); // Already logged above
        botResponseJson = { // Fallback
            answer: "I had a little trouble formatting my response perfectly with all details. Here's the main information: " + (llmOutputString || "Not available"),
            relatedProducts: []
        };
    }

    // Update short-term history ONLY if the answer is valid
    if (botResponseJson && typeof botResponseJson.answer === 'string' && botResponseJson.answer.trim() !== '' && botResponseJson.answer.indexOf('I had a little trouble formatting my response') === -1) {
        conversationHistories[userId].push(`User: ${userQuery}`);
        conversationHistories[userId].push(`Bot: ${botResponseJson.answer}`);
    }

    // Trigger summarization (example logic)
    if (conversationHistories[userId].length % 10 === 0 && conversationHistories[userId].length >= 10) {
        const summary = await summarizeConversation(userId, conversationHistories[userId].join("\n"));
        await storeMemory(userId, summary);
    }

    // Return the parsed and validated (or fallback) JSON as the top-level response
    res.json(botResponseJson);

  } catch (error) {
    console.error('Error processing question in /ask:', error);
    res.status(500).json({ 
      answer: 'Error processing your question', 
      relatedProducts: [],
      details: error.message // Send a clearer error structure
    });
  }
});

// ========================================================================
// INITIALIZATION
// ========================================================================

async function initializeApp() {
    // Initialize RAG Application (adapt to your actual setup)
    try {
        const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), VECTOR_DB_PATH);
        
        console.log(`Configuring RAG with: Search Results: ${SEARCH_RESULT_COUNT}, Temperature: ${TEMPERATURE}, Embedding Batch Size: ${EMBEDDING_BATCH_SIZE}`);

        ragApplication = await new RAGApplicationBuilder()
            .setEmbeddingModel(new OpenAiEmbeddings({
                apiKey: process.env.OPENAI_API_KEY, 
                batchSize: EMBEDDING_BATCH_SIZE 
            }))
            .setModel(SIMPLE_MODELS.OPENAI_GPT4_O) // Use the model directly without trying to set apiKey on it
            .setVectorDatabase(new LanceDb({ path: dbPath }))
            .setTemperature(TEMPERATURE)
            .setSearchResultCount(SEARCH_RESULT_COUNT)
            .build();
        console.log("RAG Application initialized successfully.");
    } catch (error) {
        console.error("FATAL ERROR: Could not initialize RAG Application. Exiting.", error);
        process.exit(1);
    }
}

// ========================================================================
// MEMORY MANAGEMENT FUNCTIONS (Conceptual)
// ========================================================================

async function getUserId(req) {
    // Example: if using Google Sign-In and verifyGoogleToken middleware:
    // if (req.user && req.user.id) return req.user.id; // or req.user.email
    return req.body.userId || req.query.userId || 'default_user'; // Placeholder
}

async function retrieveMemories(userId, currentQueryText) {
    if (!ragApplication || !promptConfig) return "";
    // console.log(`Retrieving memories for user: ${userId} based on query: ${currentQueryText}`);
    // Placeholder: Implement actual LanceDB query for user-specific summaries
    return "";
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

    // console.log(`Summarizing conversation for user: ${userId} with prompt:\n${filledPrompt}`);
    try {
        // Assuming ragApplication.model.call or a similar method exists for direct LLM invocation
        // If your RAGApplication doesn't expose a direct model.call, you might need a separate LLM client instance for summarization
        const summary = await ragApplication.model.call(filledPrompt); 
        return summary;
    } catch (e) {
        console.error("Error during summarization LLM call:", e);
        return "Error performing summarization.";
    }
}

async function storeMemory(userId, summaryText) {
    if (!ragApplication || !promptConfig) return;
    // console.log(`Storing memory for user: ${userId}, Summary: ${summaryText.substring(0,100)}...`);
    // Placeholder: Implement actual storage to LanceDB with embeddings
}

// ========================================================================
// EXPRESS APP SETUP
// ========================================================================

// ========================================================================
// CHAT ENDPOINT
// ========================================================================
app.post('/chat', async (req, res) => {
    if (!ragApplication || !promptConfig) {
        return res.status(503).json({
            answer: "Chatbot is not fully initialized. Please try again shortly.",
            relatedProducts: []
        });
    }

    const userQuery = req.body.query || req.body.question;
    const user = req.body.user || {};
    const userId = user.id || req.body.userId || req.query.userId || 'default_user';
    const userName = user.name || '';
    const children = user.children || [];

    if (!userQuery) {
        return res.status(400).json({ answer: "Query is required.", relatedProducts: [] });
    }

    if (!conversationHistories[userId]) {
        conversationHistories[userId] = [];
    }

    const longTermMemoryContext = await retrieveMemories(userId, userQuery);
    const { systemPreamble, answerFieldDetails, relatedProductsFieldDetails, closingInstruction } = promptConfig.jsonOutputInstructions;
    
    let promptForRAG = `${systemPreamble}\n\n${answerFieldDetails}\n\n${relatedProductsFieldDetails}\n\n`;

    // Inject user metadata
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

    if (longTermMemoryContext) {
        promptForRAG += `Relevant past information for ${userId}:\n${longTermMemoryContext}\n\n`;
    }

    const shortTermHistoryText = conversationHistories[userId].join("\n");
    if (shortTermHistoryText) {
        promptForRAG += `Current conversation history:\n${shortTermHistoryText}\n\n`;
    }

    promptForRAG += `User's current query: ${userQuery}\n\n${closingInstruction}`;

    // Log the prompt sent to the model
    console.log("--- Prompt sent to LLM (/chat): ---");
    console.log(promptForRAG);
    console.log("-----------------------------------");

    try {
        const result = await ragApplication.query(promptForRAG);
        // Log the complete result object for debugging
        console.log("--- Complete RAG result object (/chat): ---");
        console.log(JSON.stringify(result, null, 2));
        console.log("----------------------------------");
        
        // Extract the LLM output from the result object
        let llmOutputString = result.answer || result.content || result.text || result.response || '';

        // Log the direct output from the LLM for debugging
        console.log("--- /chat endpoint: LLM Raw Output (extracted) ---");
        console.log(llmOutputString);
        console.log("---------------------------------------------------");

        let botResponseJson;
        
        try {
            if (typeof llmOutputString !== 'string' || llmOutputString.trim() === "") {
                console.error("/chat: LLM output is not a non-empty string. Value:", llmOutputString);
                throw new Error("LLM output is not a non-empty string, cannot parse.");
            }
            
            // Clean the output string if it contains markdown code fences
            let cleanedOutput = llmOutputString;
            if (llmOutputString.includes("```")) {
                // Extract content from between code fences (```json ... ```)
                const codeBlockMatch = llmOutputString.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (codeBlockMatch && codeBlockMatch[1]) {
                    cleanedOutput = codeBlockMatch[1].trim();
                }
            }
            
            botResponseJson = JSON.parse(cleanedOutput);

            // Validate the structure: answer (string) and relatedProducts (array of objects)
            if (typeof botResponseJson.answer !== 'string' || !Array.isArray(botResponseJson.relatedProducts)) {
                console.warn("/chat: LLM output was valid JSON but not the expected top-level structure. LLM Raw:", llmOutputString);
                throw new Error("LLM output is not in the expected {answer: string, relatedProducts: array} format.");
            }

            // Validate each item in relatedProducts
            for (const item of botResponseJson.relatedProducts) {
                if (typeof item !== 'object' || item === null ||
                    typeof item.sku !== 'string' ||
                    typeof item.name !== 'string' ||
                    typeof item.description !== 'string') {
                    console.warn("/chat: An item in relatedProducts has an invalid structure. Item:", item, "LLM Raw:", llmOutputString);
                    throw new Error("An item in relatedProducts does not have the required {sku: string, name: string, description: string} structure.");
                }
                
                // Ensure all expected fields exist (add missing ones as empty strings or null)
                const expectedFields = ['brand_default_store', 'features', 'recom_age', 'top_category', 'secondary_category', 'action', 'url', 'image', 'objectID'];
                for (const field of expectedFields) {
                    if (typeof item[field] !== 'string') {
                        item[field] = item[field] !== undefined ? String(item[field]) : ''; // Convert to string or use empty string
                    }
                }
            }
        } catch (e) {
            console.error("/chat: Failed to parse LLM response as JSON or structure was invalid:", e.message);
            console.error("/chat: LLM raw output:", llmOutputString);
            botResponseJson = { // Fallback
                answer: "I had a little trouble formatting my response perfectly with all details. Here's the main information: " + llmOutputString,
                relatedProducts: []
            };
        }

        // Update short-term history ONLY if the answer is valid
        if (botResponseJson && typeof botResponseJson.answer === 'string' && botResponseJson.answer.trim() !== '' && botResponseJson.answer.indexOf('I had a little trouble formatting my response') === -1) {
            conversationHistories[userId].push(`User: ${userQuery}`);
            conversationHistories[userId].push(`Bot: ${botResponseJson.answer}`);
        }

        if (conversationHistories[userId].length > 20) {
            conversationHistories[userId] = conversationHistories[userId].slice(-20);
        }

        // Trigger summarization if needed
        if (conversationHistories[userId].length % 10 === 0 && conversationHistories[userId].length >= 10) {
            const summary = await summarizeConversation(userId, conversationHistories[userId].join("\n"));
            await storeMemory(userId, summary);
        }

        res.json(botResponseJson);
    } catch (error) {
        console.error("Error during RAG query for structured output:", error);
        res.status(500).json({
            answer: "Sorry, I encountered an error trying to process your request.",
            relatedProducts: []
        });
    }
});

// ========================================================================
// START SERVER
// ========================================================================

// Function to get all network IP addresses
function getNetworkIPs() {
  const nets = networkInterfaces();
  const results = {};

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (loopback) addresses
      if (net.family === 'IPv4' && !net.internal) {
        if (!results[name]) {
          results[name] = [];
        }
        results[name].push(net.address);
      }
    }
  }
  return results;
}

initializeApp().then(() => {
    // Start server, listening on all network interfaces (0.0.0.0)
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}. RAG App and Prompts Initialized.`);
        console.log(`Local URL: http://localhost:${PORT}`);
        
        // Display all network IPs
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