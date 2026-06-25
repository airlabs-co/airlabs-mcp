#!/usr/bin/env node
/**
 * AirLabs MCP Server
 * ------------------
 * A Model Context Protocol (MCP) server that exposes the AirLabs aviation
 * data API (https://airlabs.co) as tools for AI assistants such as Claude
 * Desktop, Cursor, and any other MCP-compatible client.
 *
 * Everything lives in this single file: tool definitions, the thin HTTP
 * client that calls AirLabs, request handling, and the stdio transport.
 *
 * The tool descriptions are intentionally detailed. They document each
 * endpoint's parameters AND explain WHEN to use each tool, including the
 * multi-step workflows needed to answer real questions (e.g. resolving a
 * city or airline name to a code before querying schedules). This helps the
 * model orchestrate correct chains of calls instead of guessing.
 *
 * Auth: set the environment variable AIRLABS_API_KEY to your API key.
 *       Get a free key at https://airlabs.co/signup
 *
 * Run:  AIRLABS_API_KEY=xxxx npx @airlabs-co/airlabs-mcp
 *
 * License: MIT
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE = "https://airlabs.co/api/v9";
const API_KEY = process.env.AIRLABS_API_KEY;

if (!API_KEY) {
  console.error(
    "[airlabs-mcp] Missing AIRLABS_API_KEY environment variable.\n" +
      "Get a free key at https://airlabs.co/signup and set it, e.g.:\n" +
      '  "env": { "AIRLABS_API_KEY": "your_key_here" }'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Thin HTTP client for the AirLabs REST API
// ---------------------------------------------------------------------------

async function airlabsRequest(
  endpoint: string,
  params: Record<string, string | number | undefined | null>
): Promise<unknown> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("api_key", API_KEY as string);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "User-Agent": "airlabs-mcp/1.1" },
    });
  } catch (err) {
    throw new Error(
      `Network error calling AirLabs /${endpoint}: ${(err as Error).message}`
    );
  }

  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `AirLabs /${endpoint} returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`
    );
  }

  if (body && body.error) {
    const e = body.error;
    throw new Error(
      `AirLabs /${endpoint} error: ${e.message || "unknown"}${e.code ? ` (${e.code})` : ""}`
    );
  }

  return body && "response" in body ? body.response : body;
}

function toToolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function toToolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
//
// Each tool wraps exactly one AirLabs endpoint. Descriptions document the
// endpoint, its parameters, common use cases, and — crucially — the WORKFLOW
// chains needed to answer multi-step questions. AirLabs uses IATA/ICAO codes
// everywhere, so the recurring pattern is: resolve a NAME to a CODE first,
// then query with that code.
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  // -------------------------------------------------------------------------
  // SINGLE FLIGHT
  // -------------------------------------------------------------------------
  {
    name: "get_flight_status",
    description:
      "TRIGGER: use automatically (no need for the user to mention 'AirLabs') whenever they ask " +
      "about the status, arrival/departure time, gate, terminal, or delay of a SPECIFIC flight " +
      "number — e.g. 'is BA117 on time?', 'when does LH401 land?', 'my flight AA6'.\n" +
      "Get the live status of ONE flight by its flight number. Returns scheduled/" +
      "estimated/actual departure & arrival times, status (scheduled/en-route/landed), " +
      "terminal, gate, baggage belt, delay minutes, codeshare info, and aircraft details. " +
      "Returns only the single closest live/scheduled/landed instance of that number.\n" +
      "USE CASES: 'Is BA117 on time?', 'What gate is LH401?', 'Will my flight be late?'.\n" +
      "INPUT: requires flight_iata OR flight_icao. If the user gives an airline NAME plus a " +
      "number (e.g. 'Wizz Air 4321'), first call get_airline_info(name) to get the IATA code " +
      "(W6) and build the flight_iata ('W64321').\n" +
      "NOTE: for ALL daily instances of a recurring number, use get_airport_schedule with " +
      "flight_iata instead — this tool returns only one.",
    inputSchema: {
      type: "object",
      properties: {
        flight_iata: { type: "string", description: "Flight IATA code-number, e.g. 'BA117', 'AA6'." },
        flight_icao: { type: "string", description: "Flight ICAO code-number, e.g. 'BAW117'. Alternative to flight_iata." },
        _fields: {
          type: "string",
          description:
            "Comma-separated fields to return, to keep the response small, e.g. " +
            "'status,arr_estimated,arr_delayed,arr_terminal,arr_gate'.",
        },
      },
    },
  },

  // -------------------------------------------------------------------------
  // AIRPORT SCHEDULE (departures / arrivals board)  -- the time-aware one
  // -------------------------------------------------------------------------
  {
    name: "get_airport_schedule",
    description:
      "TRIGGER: use automatically whenever the user asks what flights leave/arrive at an airport, " +
      "or about departures/arrivals 'today / now / soon / in the next hours', or which " +
      "destinations an airline serves from an airport right now — even without naming AirLabs.\n" +
      "Get the LIVE departures/arrivals board for an airport (real-time, up to ~10 hours " +
      "ahead). Each row has dep_time/arr_time, dep_estimated/arr_estimated, status, terminal, " +
      "gate, delay, airline and flight number. THIS is the tool for questions about WHEN " +
      "flights leave/arrive 'today' / 'soon' / 'right now'.\n" +
      "USE CASES: 'What flights leave JFK today?', 'Show Wizz Air departures from Sofia in the " +
      "next hours', 'Arrivals at LHR now'.\n" +
      "INPUT: query by dep_iata (departures) OR arr_iata (arrivals). You may ADD airline_iata " +
      "to filter by carrier, and/or flight_iata to list every instance of a number.\n" +
      "WORKFLOW for 'Which airports does <Airline> fly to from <City> soon?':\n" +
      "  1) get_airline_info(name='<Airline>')      -> airline IATA code (e.g. Wizz Air -> W6)\n" +
      "  2) search_airport_code(q='<City>')          -> airport IATA code (e.g. Sofia -> SOF)\n" +
      "  3) get_airport_schedule(dep_iata='SOF', airline_iata='W6')  -> live departures w/ times\n" +
      "  4) (optional) get_airport_info(iata_code=<each arr_iata>) -> full destination names\n" +
      "Do NOT use find_routes for 'soon/today' — that returns a weekly timetable without live " +
      "times. Use this tool when the user cares about actual times.\n" +
      "TIME WINDOW & STATUS: the board covers a window from the recent past to several hours " +
      "ahead, so it mixes flights that have not left yet, are airborne, and have already " +
      "departed/landed. Each row's 'status' tells which: scheduled = not departed yet, " +
      "active = airborne, landed = arrived (and 'cancelled'). Interpret the user's intent and " +
      "filter the rows accordingly when their wording is specific: for 'upcoming / still to " +
      "depart / next few hours' keep status=scheduled with a future dep_estimated/dep_time; for " +
      "'already left / departed' keep active/landed. If the user is NOT specific, do NOT drop " +
      "rows — show them and label each with its status and time. Never silently hide matching " +
      "flights; if filtering leaves nothing, say so and report what the board does contain.",
    inputSchema: {
      type: "object",
      properties: {
        dep_iata: { type: "string", description: "Departure airport IATA code, e.g. 'SOF' (Sofia), 'JFK'." },
        arr_iata: { type: "string", description: "Arrival airport IATA code, e.g. 'LHR'." },
        dep_icao: { type: "string", description: "Departure airport ICAO code, e.g. 'LBSF'." },
        arr_icao: { type: "string", description: "Arrival airport ICAO code, e.g. 'EGLL'." },
        airline_iata: { type: "string", description: "Filter the board by airline IATA code, e.g. 'W6' (Wizz Air)." },
        airline_icao: { type: "string", description: "Filter the board by airline ICAO code, e.g. 'WZZ'." },
        flight_iata: { type: "string", description: "List every instance of this flight IATA number." },
        flight_icao: { type: "string", description: "List every instance of this flight ICAO number." },
        limit: { type: "number", description: "Max rows (airport: up to 1000; airline: 200; free keys: 50)." },
        _fields: {
          type: "string",
          description:
            "Comma-separated fields to keep responses small, e.g. " +
            "'flight_iata,arr_iata,dep_time,dep_estimated,status'.",
        },
      },
    },
  },

  // -------------------------------------------------------------------------
  // DELAYS
  // -------------------------------------------------------------------------
  {
    name: "monitor_delays",
    description:
      "TRIGGER: use automatically whenever the user asks about delayed flights — 'are flights " +
      "delayed at <airport>?', 'show departures running late', 'is <airline> delayed now?' — " +
      "without needing to mention AirLabs.\n" +
      "List flights currently delayed beyond a threshold, optionally filtered by airport or " +
      "airline. Returns each delayed flight with its delay in minutes and new estimated time.\n" +
      "USE CASES: 'Are arrivals at LAX delayed right now?', 'Show departures delayed 60+ min at " +
      "JFK', 'Is Ryanair running late today?'.\n" +
      "INPUT: requires type ('departures' or 'arrivals'); 'delay' is the minimum minutes to " +
      "include. Optionally filter by dep_iata/arr_iata and/or airline_iata. If the user gives " +
      "an airline or airport NAME, resolve it first (get_airline_info / search_airport_code).\n" +
      "STATUS NOTE: a delay is most certain once a flight has actually left, so many results are " +
      "already airborne (status=active) rather than still waiting to depart (status=scheduled). " +
      "This is correct data, not an error. If the user specifically wants only flights that have " +
      "NOT departed yet, keep status=scheduled; if they want what is delayed in the air right " +
      "now, keep active. If they are not specific, show all matches and label each with its " +
      "status — do not silently hide delayed flights just because they are already airborne.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["departures", "arrivals"], description: "Check departure or arrival delays." },
        delay: { type: "number", description: "Minimum delay in minutes to include, e.g. 30, 60." },
        dep_iata: { type: "string", description: "Filter by departure airport IATA, e.g. 'LAX'." },
        arr_iata: { type: "string", description: "Filter by arrival airport IATA, e.g. 'LAX'." },
        airline_iata: { type: "string", description: "Filter by airline IATA code, e.g. 'AA'." },
        _fields: { type: "string", description: "Comma-separated fields to return." },
      },
      required: ["type"],
    },
  },

  // -------------------------------------------------------------------------
  // REAL-TIME POSITIONS
  // -------------------------------------------------------------------------
  {
    name: "track_live_flights",
    description:
      "TRIGGER: use automatically whenever the user asks where aircraft are flying right now, to " +
      "see planes over an area/on a map, or the live position of a specific aircraft/airline — " +
      "without naming AirLabs.\n" +
      "Get LIVE aircraft positions (lat, lng, altitude, speed, heading, squawk) for aircraft " +
      "in the air right now. This is positional/map data — NOT schedule times.\n" +
      "USE CASES: 'Show planes over New York', 'Where is aircraft N790AN right now?', 'Plot all " +
      "Lufthansa flights currently airborne'.\n" +
      "INPUT: filter by bbox (a map area), or by airline_iata, reg_number, flight_iata, " +
      "dep_iata/arr_iata, or hex. Without filters it returns a very large global list — always " +
      "filter or pass a bbox. For 'when does it depart/arrive' use get_airport_schedule or " +
      "get_flight_status instead.",
    inputSchema: {
      type: "object",
      properties: {
        bbox: {
          type: "string",
          description:
            "Map bounding box as 'SW_lat,SW_lng,NE_lat,NE_lng' (south-west lat, south-west lng, " +
            "north-east lat, north-east lng), e.g. '40.5,-74.5,41.0,-73.5'.",
        },
        airline_iata: { type: "string", description: "Filter by airline IATA code." },
        airline_icao: { type: "string", description: "Filter by airline ICAO code." },
        reg_number: { type: "string", description: "Filter by aircraft registration, e.g. 'N790AN'." },
        hex: { type: "string", description: "Filter by ICAO24 hex address, e.g. 'AAB812'." },
        flight_iata: { type: "string", description: "Filter by flight IATA number." },
        flight_icao: { type: "string", description: "Filter by flight ICAO number." },
        dep_iata: { type: "string", description: "Filter by departure airport IATA code." },
        arr_iata: { type: "string", description: "Filter by arrival airport IATA code." },
        zoom: { type: "number", description: "Map zoom 0-11 to thin out results for rendering." },
        _fields: { type: "string", description: "Comma-separated fields, e.g. 'hex,flight_iata,lat,lng,alt'." },
      },
    },
  },

  // -------------------------------------------------------------------------
  // ROUTES (weekly timetable, NOT live)
  // -------------------------------------------------------------------------
  {
    name: "find_routes",
    description:
      "TRIGGER: use automatically whenever the user asks which airlines fly a route, whether a " +
      "nonstop exists between two places, or on which days a route operates — without naming " +
      "AirLabs.\n" +
      "Look up the ROUTE timetable: which airlines operate a route and on which DAYS OF THE " +
      "WEEK, with scheduled clock times (no live status). This is a planning/reference database, " +
      "NOT real-time — use it for 'which airlines fly X to Y' and 'what days does this run', " +
      "NOT for 'is it on time today'.\n" +
      "USE CASES: 'Which airlines fly London to Tokyo?', 'What days does Wizz Air fly Sofia to " +
      "London?', 'Does anyone fly nonstop A to B?'.\n" +
      "INPUT: filter by dep_iata and/or arr_iata and/or airline_iata (resolve names to codes " +
      "first). For 'soon/today with times', use get_airport_schedule instead.",
    inputSchema: {
      type: "object",
      properties: {
        dep_iata: { type: "string", description: "Departure airport IATA code, e.g. 'SOF'." },
        arr_iata: { type: "string", description: "Arrival airport IATA code, e.g. 'LTN'." },
        dep_icao: { type: "string", description: "Departure airport ICAO code." },
        arr_icao: { type: "string", description: "Arrival airport ICAO code." },
        airline_iata: { type: "string", description: "Filter by airline IATA code, e.g. 'W6'." },
        airline_icao: { type: "string", description: "Filter by airline ICAO code." },
        flight_iata: { type: "string", description: "Filter by flight IATA number." },
        limit: { type: "number", description: "Max rows (up to 500; 50 for free keys)." },
        _fields: { type: "string", description: "Comma-separated fields to return." },
      },
    },
  },

  // -------------------------------------------------------------------------
  // NEARBY
  // -------------------------------------------------------------------------
  {
    name: "find_nearest_airport",
    description:
      "TRIGGER: use automatically whenever the user asks for the closest/nearest airport to a " +
      "location or coordinate — without naming AirLabs.\n" +
      "Find airports (and nearby cities) around a geographic coordinate, sorted by distance.\n" +
      "USE CASES: 'Closest airport to me', 'Airports within 50 km of these coordinates'.\n" +
      "INPUT: requires lat, lng and a distance (km). If omitted, distance defaults to 50. " +
      "If the user names a place instead of coordinates, use search_airport_code first to get " +
      "its lat/lng, or just search_airport_code if they only need the airport code.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude, e.g. 40.6413." },
        lng: { type: "number", description: "Longitude, e.g. -73.7781." },
        distance: { type: "number", description: "Search radius in km, e.g. 50. Defaults to 50 if omitted." },
        lang: { type: "string", description: "Optional 2-letter language code for names, e.g. 'en'." },
      },
      required: ["lat", "lng"],
    },
  },

  // -------------------------------------------------------------------------
  // SUGGEST  (resolve PLACE names -> codes; NOT airlines)
  // -------------------------------------------------------------------------
  {
    name: "search_airport_code",
    description:
      "TRIGGER: use automatically (often as the FIRST step of a chain) whenever the user names a " +
      "city/country/airport in words and a code is needed, or asks 'what's the code for <place>' " +
      "or 'airports in <place>' — without naming AirLabs.\n" +
      "Autocomplete/resolve a PLACE name (airport, city, or country) into its IATA/ICAO code. " +
      "Returns matched airports, cities, countries, and the airports belonging to a matched " +
      "city or country.\n" +
      "USE CASES: 'What's the code for Sofia?' -> SOF; 'airports in Spain' -> uses " +
      "airports_by_countries. Call this FIRST whenever the user gives a city/country NAME and " +
      "you need a code for get_airport_schedule, find_routes, or find_nearest_airport.\n" +
      "IMPORTANT: this does NOT resolve AIRLINE names. To turn an airline name (e.g. 'Wizz " +
      "Air') into its code, use get_airline_info(name=...) instead.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            "Part of an airport/city/country name, 3-30 characters, e.g. 'Sofia', 'Spain', 'JFK'.",
        },
        lang: { type: "string", description: "Optional 2-letter language code, e.g. 'en'." },
        _fields: { type: "string", description: "Comma-separated fields, e.g. 'name,iata_code,icao_code'." },
      },
      required: ["q"],
    },
  },

  // -------------------------------------------------------------------------
  // AIRLINES  (resolve AIRLINE names -> codes; this is the key one)
  // -------------------------------------------------------------------------
  {
    name: "get_airline_info",
    description:
      "TRIGGER: use automatically whenever the user asks about an airline (details, IATA/ICAO " +
      "code, fleet size, country, safety), or names an airline that must be turned into a code " +
      "for another query — without naming AirLabs.\n" +
      "Look up airline(s) in the airlines database. Returns name, IATA & ICAO codes, callsign, " +
      "country, fleet size, average fleet age, cargo/passenger/scheduled flags, safety stats and " +
      "social links.\n" +
      "USE CASES: 'Tell me about United', 'What's Wizz Air's IATA code?', 'How big is Ryanair's " +
      "fleet?', 'List airlines in Bulgaria' (country_code='BG').\n" +
      "KEY WORKFLOW ROLE: this is how you turn an AIRLINE NAME into a CODE. Call " +
      "get_airline_info(name='Wizz Air') to get iata_code 'W6', then use 'W6' in " +
      "get_airport_schedule / find_routes / monitor_delays. (search_airport_code does NOT do " +
      "airlines — only places.)\n" +
      "INPUT: provide name (fuzzy), or iata_code/icao_code (exact), or country_code to list a " +
      "country's carriers.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Airline name to search, e.g. 'Wizz Air', 'Ryanair'." },
        iata_code: { type: "string", description: "Airline IATA code, e.g. 'W6'." },
        icao_code: { type: "string", description: "Airline ICAO code, e.g. 'WZZ'." },
        country_code: { type: "string", description: "ISO-2 country code to list carriers, e.g. 'BG'." },
        callsign: { type: "string", description: "Filter by ICAO callsign." },
        _fields: { type: "string", description: "Comma-separated fields, e.g. 'name,iata_code,icao_code,country_code'." },
      },
    },
  },

  // -------------------------------------------------------------------------
  // AIRPORTS  (lookup full details by code; turn arr_iata -> full name)
  // -------------------------------------------------------------------------
  {
    name: "get_airport_info",
    description:
      "TRIGGER: use automatically whenever the user asks about an airport's details (full name, " +
      "city, country, timezone, coordinates, runways), or to expand an airport code into a full " +
      "name — without naming AirLabs.\n" +
      "Look up airport(s) in the airports database by code. Returns full name, city, country, " +
      "coordinates, elevation, timezone, runways, yearly departures and localized names.\n" +
      "USE CASES: 'What's the full name of LHR?', 'Where is SOF?', 'List all airports in " +
      "Bulgaria' (country_code='BG'), 'airports in the PAR city group' (city_code='PAR').\n" +
      "WORKFLOW ROLE: after get_airport_schedule or find_routes returns destination codes " +
      "(arr_iata), call this per code to give the user full airport NAMES instead of bare codes.\n" +
      "INPUT: iata_code or icao_code (one airport), or country_code/city_code (a list).",
    inputSchema: {
      type: "object",
      properties: {
        iata_code: { type: "string", description: "Airport IATA code, e.g. 'LHR', 'SOF'." },
        icao_code: { type: "string", description: "Airport ICAO code, e.g. 'EGLL', 'LBSF'." },
        city_code: { type: "string", description: "IATA metropolitan city code, e.g. 'PAR', 'LON'." },
        country_code: { type: "string", description: "ISO-2 country code to list a country's airports, e.g. 'BG'." },
        _fields: { type: "string", description: "Comma-separated fields, e.g. 'name,iata_code,city,country_code'." },
      },
    },
  },

  // -------------------------------------------------------------------------
  // FLEETS  (aircraft lookup)
  // -------------------------------------------------------------------------
  {
    name: "lookup_aircraft",
    description:
      "TRIGGER: use automatically whenever the user asks about a specific aircraft (by tail/" +
      "registration number or hex), its type/age/model, or about an airline's fleet — without " +
      "naming AirLabs.\n" +
      "Look up aircraft in the fleets database. Returns type, model, manufacturer, age, build " +
      "year, engines, wake category, owner airline, and latest known position (when queried by a " +
      "specific aircraft).\n" +
      "USE CASES: 'What aircraft is N790AN?' (reg_number), 'Look up hex AAB812', 'Show Wizz Air's " +
      "fleet' (airline_iata='W6'), 'How old is this plane?'.\n" +
      "INPUT: reg_number, hex, or msn for ONE aircraft; airline_iata/airline_icao to list a " +
      "carrier's fleet (use limit to cap size). If given an airline NAME, resolve via " +
      "get_airline_info first. Latest geo-position is only included when you query by a specific " +
      "aircraft (reg_number, hex, or msn).",
    inputSchema: {
      type: "object",
      properties: {
        reg_number: { type: "string", description: "Aircraft registration / tail number, e.g. 'N790AN'." },
        hex: { type: "string", description: "ICAO24 24-bit hex address, e.g. 'AAB812'." },
        msn: { type: "string", description: "Manufacturer serial number." },
        airline_iata: { type: "string", description: "List the fleet of an airline by IATA code, e.g. 'W6'." },
        airline_icao: { type: "string", description: "List the fleet of an airline by ICAO code." },
        flag: { type: "string", description: "Filter by registration country ISO-2 code, e.g. 'US'." },
        limit: { type: "number", description: "Max rows (up to 500; 50 for free keys)." },
        _fields: { type: "string", description: "Comma-separated fields, e.g. 'reg_number,model,manufacturer,age'." },
      },
    },
  },

  // -------------------------------------------------------------------------
  // CITIES
  // -------------------------------------------------------------------------
  {
    name: "get_city_info",
    description:
      "TRIGGER: use when the user asks about an aviation city code/grouping or to list cities of " +
      "a country in an aviation context — not for general geography questions.\n" +
      "Look up cities in the world cities database by code or country. Returns city name, code, " +
      "country, coordinates, timezone and population/popularity.\n" +
      "USE CASES: 'Details for the LON city group', 'List cities in Bulgaria' (country_code='BG'). " +
      "For turning a city NAME into a code, prefer search_airport_code (it also returns the " +
      "airports for that city).",
    inputSchema: {
      type: "object",
      properties: {
        city_code: { type: "string", description: "IATA city code, e.g. 'LON', 'PAR'." },
        country_code: { type: "string", description: "ISO-2 country code, e.g. 'BG'." },
        _fields: { type: "string", description: "Comma-separated fields, e.g. 'name,city_code,country_code'." },
      },
    },
  },

  // -------------------------------------------------------------------------
  // COUNTRIES
  // -------------------------------------------------------------------------
  {
    name: "get_country_info",
    description:
      "TRIGGER: use mainly as a helper to resolve a country NAME to its ISO-2 code for filtering " +
      "airlines/airports — not for general country facts.\n" +
      "Look up countries in the countries database. Returns ISO-2/ISO-3 codes, name, continent " +
      "and currency.\n" +
      "USE CASES: 'What's the country code for Bulgaria?' (-> BG), 'currency of Spain'. Useful to " +
      "resolve a country NAME to its ISO-2 code before filtering airlines/airports by " +
      "country_code.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "ISO-2 country code, e.g. 'BG', 'ES'." },
        _fields: { type: "string", description: "Comma-separated fields, e.g. 'name,code,continent'." },
      },
    },
  },
];

// Map each tool name to the AirLabs endpoint it calls.
const ENDPOINTS: Record<string, string> = {
  get_flight_status: "flight",
  get_airport_schedule: "schedules",
  monitor_delays: "delays",
  track_live_flights: "flights",
  find_routes: "routes",
  find_nearest_airport: "nearby",
  search_airport_code: "suggest",
  get_airline_info: "airlines",
  get_airport_info: "airports",
  lookup_aircraft: "fleets",
  get_city_info: "cities",
  get_country_info: "countries",
};

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "airlabs-mcp", version: "1.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const endpoint = ENDPOINTS[name];

  if (!endpoint) {
    return toToolError(`Unknown tool: ${name}`);
  }

  try {
    const params = { ...(args as Record<string, string | number | undefined | null>) };

    // AirLabs /nearby requires a distance; default to 50 km if the model omits it.
    if (name === "find_nearest_airport" && (params.distance === undefined || params.distance === null)) {
      params.distance = 50;
    }

    const data = await airlabsRequest(endpoint, params);
    return toToolResult(data);
  } catch (err) {
    return toToolError((err as Error).message);
  }
});

// ---------------------------------------------------------------------------
// Start (stdio transport — used by Claude Desktop, Cursor, etc.)
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[airlabs-mcp] AirLabs MCP server running on stdio.");
}

main().catch((err) => {
  console.error("[airlabs-mcp] Fatal error:", err);
  process.exit(1);
});
