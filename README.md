# POS Server

A FastAPI-based Point of Sale server with user hierarchy management, machine/client management, product/category management, and MQTT sync capabilities.

## Features

- **User Management**: Hierarchical user system with roles (Super Admin, Distributor, Merchant, POS User)
- **Merchant Management**: Distributors can create and manage merchants
- **POS Machine Management**: Pairing code-based machine registration and assignment
- **Product & Category Management**: Full CRUD operations with merchant-level and machine-specific support
- **MQTT Sync**: Real-time synchronization between server and POS machines via MQTT
- **JWT Authentication**: Secure token-based authentication
- **Role-Based Access Control**: Fine-grained permissions based on user roles

## Tech Stack

- **FastAPI**: Modern Python web framework
- **PostgreSQL**: Database
- **SQLAlchemy**: ORM
- **Pydantic**: Data validation
- **JWT**: Authentication
- **MQTT**: Real-time sync (Eclipse Mosquitto)
- **Poetry**: Dependency management

## Project Structure

```
pos-server/
├── app/
│   ├── models/          # SQLAlchemy database models
│   ├── schemas/         # Pydantic request/response schemas
│   ├── routers/         # API route handlers
│   ├── services/         # Business logic
│   ├── middleware/      # Authentication middleware
│   ├── config.py        # Configuration management
│   ├── database.py      # Database connection
│   └── main.py          # FastAPI application
├── scripts/
│   └── docker-mqtt.sh   # MQTT broker management script
├── docker-compose.yml   # Docker setup for MQTT
├── pyproject.toml       # Poetry configuration
└── README.md
```

## Setup

### Prerequisites

- Python 3.11+
- Poetry
- PostgreSQL
- Docker (for MQTT broker)

### Installation

1. **Clone the repository**
   ```bash
   cd pos-server
   ```

2. **Install dependencies**
   ```bash
   poetry install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Configure database**
   - Create a PostgreSQL database
   - Update `DATABASE_URL` in `.env`

5. **Start MQTT broker**
   ```bash
   ./scripts/docker-mqtt.sh start
   ```

6. **Run database migrations** (if using Alembic)
   ```bash
   poetry run alembic upgrade head
   ```

7. **Start the server**
   ```bash
   poetry run uvicorn app.main:app --reload
   ```

   Or use VSCode debugger (F5) with the provided launch configuration.

## Configuration

### Environment Variables

See `.env.example` for all available configuration options:

- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET_KEY`: Secret key for JWT tokens
- `MQTT_BROKER_HOST`: MQTT broker hostname
- `MQTT_BROKER_PORT`: MQTT broker port
- `PAIRING_CODE_LENGTH`: Length of pairing codes (default: 8)
- `PAIRING_CODE_EXPIRY_MINUTES`: Pairing code expiration (default: 15)

## API Documentation

Once the server is running, visit:
- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

## User Roles & Permissions

### Super Admin
- Full system access
- Can manage all users, merchants, and machines

### Distributor
- Can create and manage merchants
- Can generate pairing codes
- Can assign machines to merchants
- Can view their own merchants and machines

### Merchant
- Can manage their own POS machines
- Can manage products and categories
- Can manage users in their merchant
- Can trigger sync for their machines

### POS User
- Can access assigned POS machine data
- Limited read access

## Pairing Flow

1. **Distributor generates pairing code**
   ```bash
   POST /api/v1/pairing/generate
   Authorization: Bearer <distributor_token>
   ```

2. **Desktop client validates pairing code**
   ```bash
   POST /api/v1/pairing/validate
   {
     "code": "ABC12345",
     "deviceInfo": {...},
     "machineName": "Store POS 1"
   }
   ```

3. **Client receives credentials**
   - Machine ID
   - Access token
   - MQTT credentials
   - Server endpoints

4. **Distributor assigns machine to merchant**
   ```bash
   POST /api/v1/pairing/machines/{machine_id}/assign
   {
     "merchant_id": "..."
   }
   ```

## MQTT Topics

The server uses hierarchical MQTT topics:

- `pos/{merchant_id}/{machine_id}/sync/products` - Product sync data
- `pos/{merchant_id}/{machine_id}/sync/categories` - Category sync data
- `pos/{merchant_id}/{machine_id}/sync/status` - Sync status updates
- `pos/{merchant_id}/{machine_id}/sync/request` - Machine sync requests

## Product & Category API

The Product and Category APIs follow the client specification:

- **Field naming**: camelCase in JSON (categoryId, inStock, stockQuantity, etc.)
- **IDs**: UUID strings
- **Timestamps**: ISO 8601 datetime strings
- **Validation**: Full validation per specification

### Example Product Response

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Premium Coffee Beans",
  "description": "Arabica coffee beans, 500g package",
  "price": 29.99,
  "sku": "COFFEE-500-001",
  "categoryId": "660e8400-e29b-41d4-a716-446655440000",
  "imageUrl": "https://example.com/images/coffee-beans.jpg",
  "inStock": true,
  "stockQuantity": 150,
  "barcode": "1234567890123",
  "taxRate": 17.0,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-20T14:45:00.000Z"
}
```

### Example Category Response

```json
{
  "id": "660e8400-e29b-41d4-a716-446655440000",
  "name": "Beverages",
  "description": "Hot and cold beverages",
  "color": "#3B82F6",
  "imageUrl": "https://example.com/images/beverages-icon.png",
  "parentId": null,
  "isActive": true,
  "sortOrder": 1,
  "createdAt": "2024-01-10T08:00:00.000Z",
  "updatedAt": "2024-01-15T12:30:00.000Z"
}
```

## MQTT Broker Management

Use the provided script to manage the MQTT broker:

```bash
# Start MQTT broker
./scripts/docker-mqtt.sh start

# Stop MQTT broker
./scripts/docker-mqtt.sh stop

# Restart MQTT broker
./scripts/docker-mqtt.sh restart

# Check status
./scripts/docker-mqtt.sh status

# View logs
./scripts/docker-mqtt.sh logs
```

## Development

### Running Tests

```bash
poetry run pytest
```

### Code Formatting

```bash
poetry run black .
poetry run ruff check .
```

### Database Migrations

If using Alembic:

```bash
# Create a new migration
poetry run alembic revision --autogenerate -m "Description"

# Apply migrations
poetry run alembic upgrade head

# Rollback
poetry run alembic downgrade -1
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - Login and get JWT token
- `POST /api/v1/auth/register` - Register new user

### Users
- `GET /api/v1/users/me` - Get current user
- `GET /api/v1/users` - List users
- `POST /api/v1/users` - Create user
- `GET /api/v1/users/{id}` - Get user
- `PUT /api/v1/users/{id}` - Update user
- `DELETE /api/v1/users/{id}` - Delete user

### Merchants
- `GET /api/v1/merchants` - List merchants
- `POST /api/v1/merchants` - Create merchant
- `GET /api/v1/merchants/{id}` - Get merchant
- `PUT /api/v1/merchants/{id}` - Update merchant
- `DELETE /api/v1/merchants/{id}` - Delete merchant

### Pairing
- `POST /api/v1/pairing/generate` - Generate pairing code
- `POST /api/v1/pairing/validate` - Validate pairing code (public)
- `GET /api/v1/pairing/codes` - List pairing codes
- `POST /api/v1/pairing/machines/{machine_id}/assign` - Assign machine to merchant

### Machines
- `GET /api/v1/machines` - List machines
- `GET /api/v1/machines/unassigned` - List unassigned machines
- `GET /api/v1/machines/{id}` - Get machine
- `PUT /api/v1/machines/{id}` - Update machine
- `DELETE /api/v1/machines/{id}` - Delete machine
- `POST /api/v1/machines/{id}/sync` - Trigger sync

### Products
- `GET /api/v1/products` - List products
- `POST /api/v1/products` - Create product
- `GET /api/v1/products/{id}` - Get product
- `PUT /api/v1/products/{id}` - Update product
- `DELETE /api/v1/products/{id}` - Delete product

### Categories
- `GET /api/v1/categories` - List categories
- `POST /api/v1/categories` - Create category
- `GET /api/v1/categories/{id}` - Get category
- `PUT /api/v1/categories/{id}` - Update category
- `DELETE /api/v1/categories/{id}` - Delete category

## License

[Your License Here]
