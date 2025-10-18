# Use official Node.js 22.16.0 image
FROM node:22.16.0

# Install dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium-browser \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package.json .
RUN npm install
RUN npx playwright install chromium

# Copy application code
COPY . .

# Set environment variables
ENV PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV STORAGE_PATH=/var/data
ENV PORT=10000

# Expose port
EXPOSE 10000

# Start the application
CMD ["node", "server.js"]
