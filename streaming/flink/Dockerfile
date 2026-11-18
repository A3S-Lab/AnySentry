FROM maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -B package

FROM node:20-bookworm-slim AS guard-node

FROM flink:2.2.1-java17
COPY --from=guard-node /usr/local/bin/node /usr/local/bin/node
COPY job-guard.mjs /opt/anysentry/job-guard.mjs
COPY --from=build /src/target/anysentry-flink-streaming.jar /opt/flink/usrlib/anysentry-flink-streaming.jar
