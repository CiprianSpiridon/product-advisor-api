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

// Load environment variables
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), './.env') });

// Configuration
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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
let promptConfig;

// --- Short-term conversation history (simple in-memory store for demo) ---
const conversationHistories = {}; // { userId: ["User: Hi", "Bot: Hello!"] }

async function initRAG() {
  console.log('Initializing RAG system...');
  console.log('Using pre-generated embeddings from vector database...');
  
  try {
    // Create the RAG application with embedJs
    ragApplication = await new RAGApplicationBuilder()
      .setEmbeddingModel(new OpenAiEmbeddings({
        apiKey: process.env.OPENAI_API_KEY, 
        batchSize: 256 
      }))
      .setModel(SIMPLE_MODELS.OPENAI_GPT4_O)
      .setVectorDatabase(new LanceDb({ path: dbPath }))
      .setTemperature(0.2)
      .setSearchResultCount(7)
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
  // const { question } = req.body; // Old way
  const userQuery = req.body.question; // Assuming 'question' is the key from your cURL
  const userId = await getUserId(req); // Use existing getUserId, pass req to it

  if (!userQuery) {
    return res.status(400).json({ answer: "Question is required", relatedProducts: [] });
  }

  if (!ragApplication || !promptConfig) { // Ensure promptConfig is also checked
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

  if (longTermMemoryContext) {
      promptForRAG += `Relevant past information for ${userId}:\n${longTermMemoryContext}\n\n`;
  }

  const shortTermHistoryText = conversationHistories[userId].join("\n");
  if (shortTermHistoryText) {
      promptForRAG += `Current conversation history:\n${shortTermHistoryText}\n\n`;
  }

  promptForRAG += `User's current query: ${userQuery}\n\n${closingInstruction}`;

  console.log(`Processing augmented query for user ${userId} in /ask endpoint...`);
  // console.log("Prompt for RAG (/ask):", promptForRAG); // For debugging

  try {
    const result = await ragApplication.query(promptForRAG);
    // Log the complete result object for debugging
    console.log("--- Complete RAG result object: ---");
    console.log(JSON.stringify(result, null, 2));
    console.log("----------------------------------");
    
    // Handle different possible response structures
    let llmOutputString;
    if (result && typeof result === 'object') {
      if (result.answer !== undefined) {
        llmOutputString = result.answer;
      } else if (result.content !== undefined) {
        llmOutputString = result.content;
      } else if (result.text !== undefined) {
        llmOutputString = result.text;
      } else if (result.response !== undefined) {
        llmOutputString = result.response;
      } else {
        // Try to use the entire result object as the response if it's a string
        llmOutputString = typeof result === 'string' ? result : JSON.stringify(result);
      }
    } else {
      // Fallback if result is not an object
      llmOutputString = result;
    }

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
        }
    } catch (e) {
        console.error("/ask: Failed to parse LLM response as JSON or structure was invalid:", e.message);
        // console.error("/ask: LLM raw output was:", llmOutputString); // Already logged above
        botResponseJson = { // Fallback
            answer: "I had a little trouble formatting my response perfectly with all details. Here's the main information: " + (llmOutputString || "Not available"),
            relatedProducts: []
        };
    }

    // Update short-term history
    conversationHistories[userId].push(`User: ${userQuery}`);
    conversationHistories[userId].push(`Bot: ${botResponseJson.answer}`);

    if (conversationHistories[userId].length > 20) { // Manage history size
        conversationHistories[userId] = conversationHistories[userId].slice(-20);
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
    // 1. Load Prompt Configuration
    try {
        const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt_config.json');
        const configFileContent = fs.readFileSync(configPath, 'utf8');
        promptConfig = JSON.parse(configFileContent);
        console.log("Prompt configuration loaded successfully.");
    } catch (error) {
        console.error("FATAL ERROR: Could not load or parse prompt_config.json. Exiting.", error);
        process.exit(1);
    }

    // 2. Initialize RAG Application (adapt to your actual setup)
    try {
        const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectordb');

        ragApplication = await new RAGApplicationBuilder()
            .setEmbeddingModel(new OpenAiEmbeddings({
                apiKey: process.env.OPENAI_API_KEY, 
                batchSize: 256 
            }))
            .setModel(SIMPLE_MODELS.OPENAI_GPT4_O)
            .setVectorDatabase(new LanceDb({ path: dbPath }))
            .setTemperature(0.2)
            .setSearchResultCount(7)
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

    const userId = await getUserId(req);
    const userQuery = req.body.query;

    if (!userQuery) {
        return res.status(400).json({ answer: "Query is required.", relatedProducts: [] });
    }

    if (!conversationHistories[userId]) {
        conversationHistories[userId] = [];
    }

    const longTermMemoryContext = await retrieveMemories(userId, userQuery);
    const { systemPreamble, answerFieldDetails, relatedProductsFieldDetails, closingInstruction } = promptConfig.jsonOutputInstructions;
    
    let promptForRAG = `${systemPreamble}\n\n${answerFieldDetails}\n\n${relatedProductsFieldDetails}\n\n`;

    if (longTermMemoryContext) {
        promptForRAG += `Relevant past information for ${userId}:\n${longTermMemoryContext}\n\n`;
    }

    const shortTermHistoryText = conversationHistories[userId].join("\n");
    if (shortTermHistoryText) {
        promptForRAG += `Current conversation history:\n${shortTermHistoryText}\n\n`;
    }

    promptForRAG += `User's current query: ${userQuery}\n\n${closingInstruction}`;

    // console.log(`\n--- Querying RAG for user ${userId} with structured JSON output instruction ---`);
    // console.log("Prompt for RAG:\n", promptForRAG); // Debugging: can be very long

    try {
        const result = await ragApplication.query(promptForRAG);
        let llmOutputString = result.answer;
        let botResponseJson;

        try {
            botResponseJson = JSON.parse(llmOutputString);
            
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
                console.warn("LLM output was valid JSON but not the expected top-level structure. LLM Raw:", llmOutputString);
                throw new Error("LLM output is not in the expected {answer: string, relatedProducts: array} format.");
            }

            // Validate each item in relatedProducts
            for (const item of botResponseJson.relatedProducts) {
                if (typeof item !== 'object' || item === null ||
                    typeof item.sku !== 'string' ||
                    typeof item.name !== 'string' ||
                    typeof item.description !== 'string') {
                    console.warn("An item in relatedProducts has an invalid structure. Item:", item, "LLM Raw:", llmOutputString);
                    throw new Error("An item in relatedProducts does not have the required {sku: string, name: string, description: string} structure.");
                }
            }
        } catch (e) {
            console.error("Failed to parse LLM response as JSON or structure was invalid:", e.message);
            console.error("LLM raw output:", llmOutputString);
            botResponseJson = { // Fallback
                answer: "I had a little trouble formatting my response perfectly with all details. Here's the main information: " + llmOutputString,
                relatedProducts: []
            };
        }

        conversationHistories[userId].push(`User: ${userQuery}`);
        conversationHistories[userId].push(`Bot: ${botResponseJson.answer}`);

        if (conversationHistories[userId].length > 20) {
            conversationHistories[userId] = conversationHistories[userId].slice(-20);
        }

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

initializeApp().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}. RAG App and Prompts Initialized.`);
    });
}).catch(initializationError => {
    console.error("Application failed to initialize:", initializationError);
    process.exit(1);
}); 