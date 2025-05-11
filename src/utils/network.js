import { networkInterfaces } from 'os';

/**
 * Gets a list of network IP addresses (non-internal IPv4 addresses)
 * @returns {Object} Object with interface names as keys and arrays of IP addresses as values
 */
export function getNetworkIPs() {
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

/**
 * Logs server URLs (local and network) to the console
 * @param {number} port - The port number the server is running on
 */
export function logServerUrls(port) {
  console.log(`Local URL: http://localhost:${port}`);
  const networkIPs = getNetworkIPs();
  if (Object.keys(networkIPs).length > 0) {
    console.log('Network URLs:');
    for (const [interfaceName, addresses] of Object.entries(networkIPs)) {
      for (const ip of addresses) {
        console.log(`  http://${ip}:${port} (${interfaceName})`);
      }
    }
  } else {
    console.log('No network interfaces detected.');
  }
} 