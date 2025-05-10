#!/usr/bin/env node

/**
 * Simple test script to demonstrate the Product Assistant API usage
 * 
 * Run with: node test.mjs "What baby products do you have?"
 */

import fetch from 'node-fetch';
import chalk from 'chalk';

// Configuration
const API_URL = 'http://localhost:3000';
const DEFAULT_QUESTION = 'What baby products do you have?';

async function main() {
  // Get question from command line or use default
  const question = process.argv[2] || DEFAULT_QUESTION;
  
  console.log(chalk.cyan('Product Assistant API Test'));
  console.log(chalk.cyan('-------------------------'));
  console.log(chalk.yellow('Question:'), question);
  console.log(chalk.cyan('-------------------------'));
  
  try {
    // Check API health first
    console.log(chalk.gray('Checking API health...'));
    const healthResponse = await fetch(`${API_URL}/health`);
    
    if (!healthResponse.ok) {
      console.error(chalk.red('API health check failed. Is the server running?'));
      process.exit(1);
    }
    
    const healthData = await healthResponse.json();
    console.log(chalk.green('API is healthy!'));
    
    // Send the question
    console.log(chalk.gray('Sending question...'));
    const response = await fetch(`${API_URL}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
    });
    
    if (!response.ok) {
      console.error(chalk.red('Error:'), await response.text());
      process.exit(1);
    }
    
    const data = await response.json();
    
    // Display results
    console.log(chalk.cyan('-------------------------'));
    console.log(chalk.green('Answer:'));
    console.log(data.answer);
    
    if (data.relatedProducts && data.relatedProducts.length > 0) {
      console.log(chalk.cyan('-------------------------'));
      console.log(chalk.green('Related Products:'));
      
      data.relatedProducts.forEach((product, index) => {
        console.log(chalk.yellow(`#${index + 1} (Score: ${product.score ? product.score.toFixed(4) : 'N/A'})`));
        console.log(`Content: ${product.content}`);
        console.log(`Source: ${product.source || 'Unknown'}`);
        console.log('');
      });
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error.message);
    process.exit(1);
  }
}

main(); 