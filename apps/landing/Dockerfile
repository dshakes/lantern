FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Static export (next.config: output "export"): any file server will do.
FROM busybox:1.37
COPY --from=builder /app/out /www
EXPOSE 3000
CMD ["httpd", "-f", "-p", "3000", "-h", "/www"]
