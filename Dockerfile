# Node LTS (estable)
FROM node:20-slim

# Copia archivos de dependencias primero (mejor cache)
COPY package*.json ./

# Instalación robusta en CI/containers:
# - npm install NO requiere package-lock (a diferencia de npm ci)
# - omit dev deps para producción
RUN npm install --omit=dev --no-audit --no-fund --progress=false

# Copia el resto del proyecto
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
