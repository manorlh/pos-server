#!/bin/bash

# Script to manage MQTT broker in Docker

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Create Mosquitto directories if they don't exist
mkdir -p "$PROJECT_DIR/mosquitto/config"
mkdir -p "$PROJECT_DIR/mosquitto/data"
mkdir -p "$PROJECT_DIR/mosquitto/log"

# Create basic Mosquitto config if it doesn't exist
CONFIG_FILE="$PROJECT_DIR/mosquitto/config/mosquitto.conf"
if [ ! -f "$CONFIG_FILE" ]; then
    cat > "$CONFIG_FILE" <<EOF
# Mosquitto configuration for POS Server testing

# Listener on port 1883
listener 1883
protocol mqtt

# Allow anonymous connections (for testing)
allow_anonymous true

# Persistence
persistence true
persistence_location /mosquitto/data/

# Logging
log_dest file /mosquitto/log/mosquitto.log
log_type all
log_timestamp true

# Connection settings
max_connections -1
max_inflight_messages 20
max_queued_messages 1000

# Message settings
message_size_limit 0
max_packet_size 0
EOF
    echo -e "${GREEN}Created Mosquitto configuration file${NC}"
fi

# Function to start MQTT broker
start_mqtt() {
    echo -e "${YELLOW}Starting MQTT broker...${NC}"
    cd "$PROJECT_DIR"
    docker-compose up -d mqtt
    echo -e "${GREEN}MQTT broker started${NC}"
    echo -e "Broker available at: ${GREEN}mqtt://localhost:1883${NC}"
}

# Function to stop MQTT broker
stop_mqtt() {
    echo -e "${YELLOW}Stopping MQTT broker...${NC}"
    cd "$PROJECT_DIR"
    docker-compose stop mqtt
    echo -e "${GREEN}MQTT broker stopped${NC}"
}

# Function to restart MQTT broker
restart_mqtt() {
    echo -e "${YELLOW}Restarting MQTT broker...${NC}"
    stop_mqtt
    start_mqtt
}

# Function to show MQTT broker status
status_mqtt() {
    cd "$PROJECT_DIR"
    docker-compose ps mqtt
}

# Function to show MQTT broker logs
logs_mqtt() {
    cd "$PROJECT_DIR"
    docker-compose logs -f mqtt
}

# Main script logic
case "$1" in
    start)
        start_mqtt
        ;;
    stop)
        stop_mqtt
        ;;
    restart)
        restart_mqtt
        ;;
    status)
        status_mqtt
        ;;
    logs)
        logs_mqtt
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "Commands:"
        echo "  start   - Start the MQTT broker"
        echo "  stop    - Stop the MQTT broker"
        echo "  restart - Restart the MQTT broker"
        echo "  status  - Show MQTT broker status"
        echo "  logs    - Show MQTT broker logs"
        exit 1
        ;;
esac

exit 0

