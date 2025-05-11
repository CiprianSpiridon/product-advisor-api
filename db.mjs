import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

let client = null;
let db = null;

const MONGO_URI = process.env.MONGO_STORE_CONNECTION_URI;
const MONGO_DB_NAME = process.env.MONGO_DATABASE || 'product_db';
const PRODUCTS_COLLECTION = process.env.MONGO_COLLECTION_PRODUCTS || 'products';

// Fallback if URI is not provided
const MONGO_USER = process.env.MONGO_INITDB_ROOT_USERNAME;
const MONGO_PASSWORD = process.env.MONGO_INITDB_ROOT_PASSWORD;
const MONGO_HOST = process.env.MONGO_HOST || 'mongo';
const MONGO_PORT = process.env.MONGO_PORT || '27017';

export async function initDatabase() {
  if (db) {
    console.log('MongoDB already connected.');
    return true;
  }

  let connectionUri = MONGO_URI;
  if (!connectionUri) {
    if (!MONGO_USER || !MONGO_PASSWORD) {
      console.warn('MongoDB URI not provided and root credentials are not fully set. Attempting to connect without auth. This may fail or be insecure.');
      connectionUri = `mongodb://${MONGO_HOST}:${MONGO_PORT}/${MONGO_DB_NAME}`;
    } else {
      connectionUri = `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASSWORD)}@${MONGO_HOST}:${MONGO_PORT}/${MONGO_DB_NAME}?authSource=admin`;
    }
  }

  try {
    client = new MongoClient(connectionUri);
    await client.connect();
    db = client.db(MONGO_DB_NAME); // Ensure we are using the correct database name
    console.log(`Connected to MongoDB: ${connectionUri.replace(/:([^:@\/]+)@/, ':<password>@')}`); // Log URI safely
    
    // Ensure indexes for products collection (optional, but good for performance)
    try {
        const productsCollection = db.collection(PRODUCTS_COLLECTION);
        await productsCollection.createIndex({ sku: 1 }, { unique: true });
        await productsCollection.createIndex({ name: "text" }); // For text search on name
        console.log(`Ensured indexes on ${PRODUCTS_COLLECTION} collection.`);
    } catch (indexError) {
        console.warn(`Could not ensure indexes on ${PRODUCTS_COLLECTION}: ${indexError.message}. This might happen if run in parallel or with insufficient permissions.`);
    }

    return true;
  } catch (error) {
    console.error('Error initializing MongoDB database:', error);
    client = null; // Reset client on error
    db = null; // Reset db on error
    return false;
  }
}

export async function importProductsFromCSV(csvPath) {
  if (!db) {
    console.error('MongoDB not initialized. Call initDatabase() first.');
    return false;
  }

  try {
    console.log(`Importing products from ${csvPath} into MongoDB collection: ${PRODUCTS_COLLECTION}`);
    
    const csvFileContent = fs.readFileSync(csvPath, 'utf8');
    const products = parse(csvFileContent, {
      columns: true,
      skip_empty_lines: true,
    });
    
    console.log(`Found ${products.length} products in CSV file`);
    if (products.length === 0) {
      console.log('No products to import.');
      return true;
    }

    const productsCollection = db.collection(PRODUCTS_COLLECTION);
    
    // Prepare bulk operations for efficient upsert
    const operations = products.map(product => ({
      updateOne: {
        filter: { sku: product.sku || 'N/A' }, // Ensure SKU is present, provide a default if not
        update: { $set: product },
        upsert: true,
      },
    }));

    const result = await productsCollection.bulkWrite(operations);
    console.log(`Imported products into MongoDB: ${result.upsertedCount} new, ${result.modifiedCount} updated, ${result.matchedCount} matched.`);
    
    return true;
  } catch (error) {
    console.error('Error importing products to MongoDB:', error);
    return false;
  }
}

export async function getProductsBySKUs(skus) {
  if (!db) {
    console.error('MongoDB not initialized. Call initDatabase() first.');
    return [];
  }
  
  try {
    if (!Array.isArray(skus) || skus.length === 0) {
      return [];
    }
    
    const productsCollection = db.collection(PRODUCTS_COLLECTION);
    const products = await productsCollection.find({ sku: { $in: skus } }).toArray();
    
    return products;
  } catch (error) {
    console.error('Error fetching products by SKUs from MongoDB:', error);
    return [];
  }
}

export async function closeDatabase() {
  if (client) {
    try {
      await client.close();
      console.log('MongoDB connection closed');
    } catch (error) {
      console.error('Error closing MongoDB connection:', error);
    }
    client = null;
    db = null;
  }
} 