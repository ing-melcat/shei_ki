# Usa Node LTS (estable)
FROM node:20-slim

WORKDIR /app

# Copia archivos de dependencias primero (mejor cache)
COPY package*.json ./

# Instala solo dependencias de producción (más rápido y estable)
RUN npm ci --omit=dev --no-audit --no-fund --progress=false

# Copia el resto del proyecto
COPY . .

# Railway usa PORT, nosotros lo respetamos en index.js
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]