import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

// SQLite database setup
let db = null;

export async function initDatabase() {
  try {
    const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'products.db');
    
    // Open database connection
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });
    
    console.log('Connected to SQLite database');
    
    // Create products table if it doesn't exist
    await db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY,
        name TEXT,
        brand_default_store TEXT,
        description TEXT,
        features TEXT,
        recom_age TEXT,
        top_category TEXT,
        secondary_category TEXT,
        action TEXT,
        url TEXT,
        image TEXT,
        objectID TEXT,
        price TEXT
      )
    `);
    
    return true;
  } catch (error) {
    console.error('Error initializing database:', error);
    return false;
  }
}

export async function importProductsFromCSV(csvPath) {
  if (!db) {
    console.error('Database not initialized');
    return false;
  }
  
  let stmt = null;
  
  try {
    console.log(`Importing products from ${csvPath}`);
    
    // Read and parse CSV
    const csvFileContent = fs.readFileSync(csvPath, 'utf8');
    const products = parse(csvFileContent, {
      columns: true,
      skip_empty_lines: true,
    });
    
    console.log(`Found ${products.length} products in CSV file`);
    
    // Begin transaction for faster inserts
    await db.exec('BEGIN TRANSACTION');
    
    // Prepare REPLACE statement instead of INSERT to handle duplicates
    stmt = await db.prepare(`
      REPLACE INTO products (
        sku, name, brand_default_store, description, features, 
        recom_age, top_category, secondary_category, action, 
        url, image, objectID, price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    // Insert/replace products
    let replacedCount = 0;
    let insertedCount = 0;
    
    for (const product of products) {
      // Check if product already exists to track stats
      const existing = await db.get('SELECT 1 FROM products WHERE sku = ?', product.sku || '');
      
      await stmt.run([
        product.sku || '',
        product.name || '',
        product.brand_default_store || '',
        product.description || '',
        product.features || '',
        product.recom_age || '',
        product.top_category || '',
        product.secondary_category || '',
        product.action || '',
        product.url || '',
        product.image || '',
        product.objectID || '',
        product.price || ''
      ]);
      
      if (existing) {
        replacedCount++;
      } else {
        insertedCount++;
      }
    }
    
    // Finalize the statement properly
    if (stmt) {
      await stmt.finalize();
      stmt = null;
    }
    
    // Commit transaction
    await db.exec('COMMIT');
    console.log(`Imported ${products.length} products into database (${insertedCount} new, ${replacedCount} replaced)`);
    
    // Create indices for better search performance
    await db.exec('CREATE INDEX IF NOT EXISTS idx_sku ON products(sku)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_name ON products(name)');
    
    return true;
  } catch (error) {
    // Rollback in case of error
    await db.exec('ROLLBACK');
    console.error('Error importing products:', error);
    return false;
  } finally {
    // Ensure statement is finalized even in case of error
    if (stmt) {
      try {
        await stmt.finalize();
      } catch (err) {
        console.error('Error finalizing statement:', err);
      }
    }
  }
}

export async function getProductsBySKUs(skus) {
  if (!db) {
    console.error('Database not initialized');
    return [];
  }
  
  try {
    if (!Array.isArray(skus) || skus.length === 0) {
      return [];
    }
    
    // Create placeholders for the query
    const placeholders = skus.map(() => '?').join(',');
    
    // Get products by SKUs
    const products = await db.all(
      `SELECT * FROM products WHERE sku IN (${placeholders})`,
      skus
    );
    
    return products;
  } catch (error) {
    console.error('Error fetching products by SKUs:', error);
    return [];
  }
}

export async function closeDatabase() {
  if (db) {
    await db.close();
    console.log('Database connection closed');
  }
} 