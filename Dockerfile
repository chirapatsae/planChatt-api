# Dockerfile for NestJS production
FROM node:18-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18-alpine as prod
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/fonts ./dist/fonts
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["npm", "run", "start:prod"] 