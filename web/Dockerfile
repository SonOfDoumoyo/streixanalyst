# The web app as a small standalone Node server (used by deploy/oracle). Works on ARM (Oracle's free Ampere VMs) and x86.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# where the API is: only used for the /api fallback rewrite; the reverse proxy sends /api straight to the API
ARG BACKEND_URL=http://api:8000
ENV BACKEND_URL=$BACKEND_URL BUILD_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
