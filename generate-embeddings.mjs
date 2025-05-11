#!/usr/bin/env node

import { RAGApplicationBuilder, SIMPLE_MODELS } from '@llm-tools/embedjs';
import { OpenAiEmbeddings } from '@llm-tools/embedjs-openai';
import { CsvLoader } from '@llm-tools/embedjs-loader-csv';
import { QdrantDb } from '@llm-tools/embedjs-qdrant';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { initDatabase, importProductsFromCSV, closeDatabase } from './db.mjs';

// Load environment variables and configuration
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), './.env') });

// Load app configuration
let appConfig;
try {
  const appConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config/app.json');
  const appConfigContent = fs.readFileSync(appConfigPath, 'utf8');
  appConfig = JSON.parse(appConfigContent);
  console.log("App configuration loaded from config/app.json");
} catch (error) {
  console.error("Error loading app configuration:", error.message);
  process.exit(1);
}

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is required');
  process.exit(1);
}

// Apply configuration
const SEARCH_RESULT_COUNT = parseInt(process.env.SEARCH_RESULT_COUNT || appConfig.rag.searchResultCount, 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || appConfig.rag.temperature);
const EMBEDDING_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || appConfig.rag.embeddingBatchSize, 10);

// Qdrant Configuration from environment variables
const QDRANT_HOST = process.env.QDRANT_HOST;
const QDRANT_HTTP_PORT = parseInt(process.env.QDRANT_HTTP_PORT, 10);
const QDRANT_API_KEY = process.env.QDRANT_API_KEY; // Can be undefined if not set
const QDRANT_COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'product_embeddings';

// Path configuration
const csvPath = path.join(path.dirname(fileURLToPath(import.meta.url)), appConfig.dataLoader.csvPath);
const tempDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'temp_data');
const PROGRESS_FILE_PATH = path.join(tempDir, 'embedding_progress.json');

// Batching configuration
const MAX_RECORDS_PER_SUB_BATCH = 1; // User-defined preferred records per sub-batch
const MAX_CHARS_PER_API_BATCH = 750000; // Safeguard for API token limits

function readLastProcessedRecordIndex() {
  if (fs.existsSync(PROGRESS_FILE_PATH)) {
    try {
      const progressData = JSON.parse(fs.readFileSync(PROGRESS_FILE_PATH, 'utf8'));
      if (progressData && typeof progressData.lastProcessedRecordIndex === 'number') {
        return progressData.lastProcessedRecordIndex;
      }
    } catch (error) {
      console.warn('Could not read or parse progress file. Starting from scratch.', error);
    }
  }
  return -1; // Indicates no prior progress or start from the beginning
}

function saveProgress(index) {
  try {
    fs.writeFileSync(PROGRESS_FILE_PATH, JSON.stringify({ lastProcessedRecordIndex: index }), 'utf8');
  } catch (error) {
    console.error('Failed to save progress:', error);
  }
}

async function importDataToSQLite() {
  console.log('Step 1: Importing data to SQLite database...');
  
  // Initialize the database
  const dbInitialized = await initDatabase();
  if (!dbInitialized) {
    console.error('Failed to initialize SQLite database');
    return false;
  }
  
  // Import products from CSV
  const importResult = await importProductsFromCSV(csvPath);
  if (!importResult) {
    console.error('Failed to import products to SQLite database');
    return false;
  }
  
  console.log('Successfully imported products to SQLite database');
  return true;
}

async function generateEmbeddings() {
  // Construct the Qdrant URL
  const qdrantUrl = `http://${QDRANT_HOST}:${QDRANT_HTTP_PORT}`;
  console.log('Step 2: Starting embedding generation process...');
  console.log(`Loading products from ${csvPath}`);
  console.log(`Storing embeddings in Qdrant: URL: '${qdrantUrl}', Collection (ClusterName): '${QDRANT_COLLECTION_NAME}'`);

  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    console.log(`QdrantDb PRE-INIT (generate-embeddings): URL: '${qdrantUrl}', API Key: '${QDRANT_API_KEY ? "Exists" : "Not Set"}', ClusterName: '${QDRANT_COLLECTION_NAME}'`);

    const ragApplication = await new RAGApplicationBuilder()
      .setEmbeddingModel(new OpenAiEmbeddings({ batchSize: EMBEDDING_BATCH_SIZE }))
      .setModel(SIMPLE_MODELS.OPENAI_GPT4_TURBO)
      .setVectorDatabase(new QdrantDb({ 
        url: qdrantUrl,                       // Correct: Pass the full URL
        apiKey: QDRANT_API_KEY,               // Correct: Pass apiKey directly
        clusterName: QDRANT_COLLECTION_NAME   // Correct: Use clusterName
      }))
      .setTemperature(TEMPERATURE)
      .setSearchResultCount(SEARCH_RESULT_COUNT)
      .build();

    console.log('Reading CSV file...');
    const csvFileContent = fs.readFileSync(csvPath, 'utf8');
    const allRecords = parse(csvFileContent, {
      columns: true,
      skip_empty_lines: true,
    });

    console.log(`Total records in CSV: ${allRecords.length}`);

    let lastProcessedRecordIndex = readLastProcessedRecordIndex();
    let currentRecordIndex = lastProcessedRecordIndex + 1;

    if (currentRecordIndex > 0 && currentRecordIndex < allRecords.length) {
      console.log(`Resuming from record index ${currentRecordIndex} (approx ${Math.round((currentRecordIndex / allRecords.length) * 100)}% completed).`);
    } else if (currentRecordIndex >= allRecords.length && allRecords.length > 0) {
      console.log('All records seem to have been processed already based on progress file.');
      return true;
    }

    const startTime = Date.now();
    let overallProcessedCountInSession = 0;
    let batchNumber = 0;

    const header = allRecords.length > 0 ? Object.keys(allRecords[0]).join(',') : '';
    if (!header) {
        console.log("CSV file is empty or has no header.");
        return true;
    }
    // Define the single header for our formatted text representation
    const formattedTextHeader = "product_text_representation"; 

    while (currentRecordIndex < allRecords.length) {
      batchNumber++;
      let subBatchRecords = [];
      let subBatchChars = 0;
      const subBatchStartIndex = currentRecordIndex;

      // Create a sub-batch respecting MAX_RECORDS_PER_SUB_BATCH and MAX_CHARS_PER_API_BATCH
      for (let i = 0; i < MAX_RECORDS_PER_SUB_BATCH && currentRecordIndex < allRecords.length; ++i) {
        const record = allRecords[currentRecordIndex];
        const recordString = Object.values(record).join(',');
        const recordChars = recordString.length;

        if (subBatchRecords.length > 0 && (subBatchChars + recordChars > MAX_CHARS_PER_API_BATCH)) {
          break; // This record would make the sub-batch too large in characters
        }
        
        subBatchRecords.push(record);
        subBatchChars += recordChars;
        currentRecordIndex++;

        if (subBatchChars >= MAX_CHARS_PER_API_BATCH) {
            break; // Sub-batch char limit reached
        }
      }
      
      if (subBatchRecords.length === 0) {
        if (currentRecordIndex < allRecords.length) { // If there are still records, means one record is too big
            console.error(`Error: Record at index ${currentRecordIndex} is too large by itself (~${allRecords[currentRecordIndex] ? Object.values(allRecords[currentRecordIndex]).join(',').length : 0} chars) and exceeds MAX_CHARS_PER_API_BATCH (${MAX_CHARS_PER_API_BATCH}). Skipping this record.`);
            saveProgress(currentRecordIndex); // Mark as processed/skipped
            currentRecordIndex++; // Move to the next record
            overallProcessedCountInSession++; // Count as processed for session log
            continue; // Skip to the next iteration of the main while loop
        } else {
            break; // No more records
        }
      }

      console.log(`Processing API batch ${batchNumber} (records ${subBatchStartIndex + 1} to ${currentRecordIndex}) with ${subBatchRecords.length} records, ~${subBatchChars} characters...`);

      const batchFilePath = path.join(tempDir, `_temp_api_batch_${batchNumber}.csv`);
      
      // Create the formatted text representation for each product
      const formattedProductTexts = subBatchRecords.map(record => {
        const filteredRecord = {...record};
        delete filteredRecord.image;
        delete filteredRecord.url;
        
        // Ensure SKU is present and properly formatted (though it will be part of the text)
        if (!filteredRecord.sku || filteredRecord.sku.trim() === '') {
          console.warn(`Warning: Record is missing a valid SKU (will still be processed): ${JSON.stringify(record)}`);
        }
        
        // Construct the "FieldName: Value" string
        // Use original header field names for clarity if possible, or just iterate keys
        // For this example, let's use the keys from the filteredRecord directly
        let textRepresentation = Object.entries(filteredRecord)
          .map(([key, value]) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${String(value).trim()}`)
          .join('\n');
        
        return textRepresentation;
      });

      // The CSV lines will now be just the formatted texts, each needing to be a single CSV field (quoted if it contains newlines)
      const csvLines = formattedProductTexts.map(text => {
        // Ensure the entire multi-line text is treated as a single CSV field
        // by quoting it and escaping internal quotes.
        const strValue = String(text);
        if (strValue.includes(',') || strValue.includes('\"') || strValue.includes('\n')) {
          return `\"${strValue.replace(/\"/g, '\"\"')}\"`
        }
        return strValue;
      });
      
      // Log SKU check for the first few records (from the original subBatchRecords)
      if (batchNumber === 1 && subBatchRecords.length > 0) {
        console.log("SKU Check for first record in first batch:");
        console.log(`Record 1 - SKU: ${subBatchRecords[0].sku || 'MISSING'}`);
      }

      fs.writeFileSync(batchFilePath, [formattedTextHeader, ...csvLines].join('\n'));
      console.log(`Created temporary batch file with formatted text for ${subBatchRecords.length} records`);

      try {
        await ragApplication.addLoader(new CsvLoader({ filePathOrUrl: batchFilePath }));
        saveProgress(currentRecordIndex - 1); // Save progress after successful API call
        overallProcessedCountInSession += subBatchRecords.length;
        console.log(`Processed ${currentRecordIndex} of ${allRecords.length} records total (${Math.round((currentRecordIndex / allRecords.length) * 100)}%). This session: ${overallProcessedCountInSession} records.`);
      } catch (e) {
        console.error(`Error processing API batch file ${batchFilePath} (records ${subBatchStartIndex + 1} to ${currentRecordIndex}):`, e.message);
        if (e.stack) console.error(e.stack);
        console.error(`This batch had ${subBatchRecords.length} records and ~${subBatchChars} characters.`);
        // Do NOT save progress here, so it retries this batch next time
        throw e; // Re-throw to stop the process, will resume from before this batch next run
      } finally {
        if (fs.existsSync(batchFilePath)) {
            fs.unlinkSync(batchFilePath);
        }
      }
    }

    const endTime = Date.now();
    if (overallProcessedCountInSession > 0) {
        console.log(`Embeddings generation session completed successfully in ${(endTime - startTime) / 1000} seconds`);
    } else if (currentRecordIndex >= allRecords.length) {
        console.log("No new records processed in this session. All records were likely processed previously.");
    }
    console.log('Vector database is ready for use by the API');

    return true;
  } catch (error) {
    // Error from outside the loop or re-thrown from inside
    console.error('Critical error during embedding generation:', error.message);
    if (error.stack) {
        console.error(error.stack);
    }
    return false;
  }
}

// Execute both data import and embedding generation
(async () => {
  try {
    console.log("=== Starting combined data import and embedding generation ===");
    
    // Step 1: Import data to SQLite
    const sqliteImportSuccess = await importDataToSQLite();
    if (!sqliteImportSuccess) {
      console.error('Failed to import data to SQLite. Stopping process.');
      process.exit(1);
    }
    
    // Step 2: Generate embeddings
    const embeddingsSuccess = await generateEmbeddings();
    if (!embeddingsSuccess) {
      console.error('Embedding generation failed or was interrupted.');
      process.exit(1);
    }
    
    // Close database connection
    await closeDatabase();
    
    console.log('=== Data import and embedding generation completed successfully ===');
    process.exit(0);
  } catch (error) {
    console.error('Unexpected error during process:', error);
    await closeDatabase();
    process.exit(1);
  }
})(); 