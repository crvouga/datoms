# Docker Compose Setup for Database Testing

This Docker Compose file sets up multiple database backends for testing datalog implementations with different SQL databases.

## Services

### PostgreSQL

- **Port**: 5432
- **User**: datoms
- **Password**: datoms
- **Database**: datoms_test
- **Connection String**: `postgresql://datoms:datoms@localhost:5432/datoms_test`

### MySQL

- **Port**: 3306
- **Root Password**: datoms_root
- **User**: datoms
- **Password**: datoms
- **Database**: datoms_test
- **Connection String**: `mysql://datoms:datoms@localhost:3306/datoms_test`

### MariaDB

- **Port**: 3307 (to avoid conflict with MySQL)
- **Root Password**: datoms_root
- **User**: datoms
- **Password**: datoms
- **Database**: datoms_test
- **Connection String**: `mariadb://datoms:datoms@localhost:3307/datoms_test`

## Usage

### Using npm scripts (recommended)

```bash
# Start all databases
npm run docker:up

# Stop all databases
npm run docker:down

# View logs
npm run docker:logs

# Check service status
npm run docker:ps

# Stop and remove volumes (clean slate)
npm run docker:clean
```

### Using docker-compose directly

#### Start all databases

```bash
docker-compose up -d
```

#### Start a specific database

```bash
docker-compose up -d postgres
docker-compose up -d mysql
docker-compose up -d mariadb
```

#### Stop all databases

```bash
docker-compose down
```

#### Stop and remove volumes (clean slate)

```bash
docker-compose down -v
```

#### View logs

```bash
docker-compose logs -f postgres
docker-compose logs -f mysql
docker-compose logs -f mariadb
```

#### Check service status

```bash
docker-compose ps
```

## Testing with Different Backends

To test your datalog implementation with these databases, you'll need to:

1. Create a `SqlConnection` implementation for your preferred SQL client library
2. Extend `SqlDatabase` and implement `getDialect()` to return the appropriate dialect
3. Use the connection strings above to connect

### Example Connection Implementations Needed

- **PostgreSQL**: Use `pg`, `postgres`, or `postgres.js`
- **MySQL/MariaDB**: Use `mysql2`, `mysql`, or `mariadb`

The library provides `SqlDatabase` as an abstract base class and `SqlConnection` interface, so you can implement database-specific connections using any SQL client library.

## Notes

- Data persists in Docker volumes between container restarts
- Use `docker-compose down -v` to completely remove all data
- Health checks ensure databases are ready before use
- All databases are on the same Docker network for easy inter-service communication
