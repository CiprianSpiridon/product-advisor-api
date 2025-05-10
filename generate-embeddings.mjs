#!/usr/bin/env node

import { RAGApplicationBuilder, SIMPLE_MODELS } from '@llm-tools/embedjs';
import { OpenAiEmbeddings } from '@llm-tools/embedjs-openai';
import { CsvLoader } from '@llm-tools/embedjs-loader-csv';
import { LanceDb } from '@llm-tools/embedjs-lancedb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

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

// Path configuration
const csvPath = path.join(path.dirname(fileURLToPath(import.meta.url)), appConfig.dataLoader.csvPath);
const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), appConfig.vectorDb.path);
const tempDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'temp_data');
const PROGRESS_FILE_PATH = path.join(tempDir, 'embedding_progress.json');

// Batching configuration
const MAX_RECORDS_PER_SUB_BATCH = 100; // User-defined preferred records per sub-batch
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

async function generateEmbeddings() {
  console.log('Starting embedding generation process...');
  console.log(`Loading products from ${csvPath}`);
  console.log(`Storing embeddings in ${dbPath}`);

  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const ragApplication = await new RAGApplicationBuilder()
      .setEmbeddingModel(new OpenAiEmbeddings({ batchSize: EMBEDDING_BATCH_SIZE }))
      .setModel(SIMPLE_MODELS.OPENAI_GPT4_O)
      .setVectorDatabase(new LanceDb({ path: dbPath }))
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
      
      const csvLines = subBatchRecords.map(record => {
        return Object.values(record).map(value => {
          const strValue = String(value);
          if (strValue.includes(',') || strValue.includes('\"') || strValue.includes('\n')) {
            return `\"${strValue.replace(/\"/g, '\"\"')}\"`
          }
          return strValue;
        }).join(',');
      });

      fs.writeFileSync(batchFilePath, [header, ...csvLines].join('\n'));
      console.log(`--- Content of ${batchFilePath} (Batch ${batchNumber}) ---`);
      console.log(fs.readFileSync(batchFilePath, 'utf8'));
      console.log(`---------------------------------`); 

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

// Execute the embedding generation
(async () => {
  const success = await generateEmbeddings();
  if (success) {
    console.log('Embedding generation finished.');
    process.exit(0);
  } else {
    console.error('Embedding generation failed or was interrupted.');
    process.exit(1);
  }
})(); 