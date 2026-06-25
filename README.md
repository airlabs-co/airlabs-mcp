# AirLabs MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

This [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server provides access to the [AirLabs](https://airlabs.co) aviation data API. It lets AI assistants such as Claude Desktop and Cursor access real-time flight data, airport schedules, delays, and reference databases for airlines, airports, aircraft fleets and routes — directly through natural-language questions.

The entire server lives in a single file (`index.ts`): tool definitions, the AirLabs HTTP client, request handling and the stdio transport.

## Features

- **Live flight status** — look up any flight by number and get status, gate, terminal and delay.
- **Airport schedules** — departures and arrivals boards for any airport.
- **Delay monitoring** — find flights delayed beyond a threshold at an airport or airline.
- **Real-time positions** — live aircraft coordinates, altitude, speed and heading by area, airline or registration.
- **Nearest airport** — closest airports to any coordinate.
- **Reference databases** — airlines, airports, aircraft fleets (by tail number or ICAO24 hex) and route networks.
- **Code resolution** — turn a place or airline name into its IATA/ICAO code.

## Prerequisites

1. **Node.js** 18.0.0 or higher.
2. **AirLabs API key** — get a free key at <https://airlabs.co/signup>.

## Installation

### Via npm

```bash
npm install -g @airlabs-co/airlabs-mcp
```

## Configuration

### Claude Desktop Integration

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "airlabs": {
      "command": "npx",
      "args": ["@airlabs-co/airlabs-mcp@latest"],
      "env": {
        "AIRLABS_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**Notes:**

- Replace `your_api_key_here` with your actual AirLabs API key.
- Restart Claude Desktop after editing the config.
- If you build from source locally, use `"command": "node", "args": ["/path/to/build/index.js"]`.

### Other MCP Clients

Run the server directly over stdio:

```bash
AIRLABS_API_KEY=your_api_key_here npx @airlabs/airlabs-mcp
```

## Available Tools

| Tool | AirLabs endpoint | Purpose |
| --- | --- | --- |
| `get_flight_status` | `/flight` | Live status of one flight by IATA/ICAO number |
| `get_airport_schedule` | `/schedules` | Departures / arrivals board for an airport |
| `monitor_delays` | `/delays` | Flights delayed beyond a threshold |
| `track_live_flights` | `/flights` | Live aircraft positions by area, airline or registration |
| `find_nearest_airport` | `/nearby` | Closest airports to a coordinate |
| `search_airport_code` | `/suggest` | Resolve a name to an IATA/ICAO code |
| `get_airline_info` | `/airlines` | Airline details by code |
| `get_airport_info` | `/airports` | Airport details by code |
| `lookup_aircraft` | `/fleets` | Aircraft by registration or ICAO24 hex |
| `find_routes` | `/routes` | Which airlines fly a given route |

All tools accept an optional `_fields` parameter (where the endpoint supports it) to return only selected fields and keep responses compact.

## Usage Examples

Once configured, just ask your assistant:

- *"Is flight BA117 on time?"* → `get_flight_status`
- *"What flights are leaving JFK today?"* → `get_airport_schedule`
- *"Are arrivals delayed at LAX by more than 30 minutes?"* → `monitor_delays`
- *"Show me planes flying over New York."* → `track_live_flights`
- *"What aircraft is registration N790AN?"* → `lookup_aircraft`
- *"Which airlines fly from London to Tokyo?"* → `find_routes`

## Development

### Building from source

```bash
git clone https://github.com/airlabs-co/airlabs-mcp.git
cd airlabs-mcp
npm install
npm run build
```

### Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Submit a pull request.

## Support

- **Documentation**: <https://airlabs.co/docs>
- **Issues**: [GitHub Issues](https://github.com/airlabs-co/airlabs-mcp/issues)
- **API support**: <https://airlabs.co/faq#Contact>

## License

MIT License — see [LICENSE](LICENSE).
