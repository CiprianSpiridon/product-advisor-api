FROM node:22-alpine

WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# The app binds to this port (update if your app uses a different port)
EXPOSE 3000 

# Define the command to run the app (assuming index.mjs is the main server)
# CMD ["node", "index.mjs"] 
CMD ["node", "src/index.js"] 
