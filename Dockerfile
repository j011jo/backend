FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000  # Back4app 会代理到此端口，支持 WS

CMD ["npm", "start"]
