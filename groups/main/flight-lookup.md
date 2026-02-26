## On-demand award availability checks

When the user asks you to check award seat availability, use the seats.aero API directly — do NOT use agent-browser.

```bash
KEY=$(grep SEATS_AERO_API_KEY /workspace/project/.env | cut -d= -f2)
curl -s "https://seats.aero/partnerapi/search?origin_airport=SYD&destination_airport=BOS&sources=qantas&cabins=economy,premium,business,first&start_date=2026-06-08&end_date=2026-06-09&order_by=lowest_mileage&take=50" \
  -H "Partner-Authorization: $KEY"
```

Parameters: `origin_airport`/`destination_airport` (IATA), `start_date`/`end_date`, `sources=qantas`, `cabins` (comma-separated), `order_by=lowest_mileage`.

Each result in `data[]` has: `Date`, `Origin`, `Destination`, `YAvailable`, `WAvailable`, `JAvailable`, `FAvailable`, `YMileageCost`, `WMileageCost`, `JMileageCost`, `FMileageCost`, `Source` (direct vs connecting).

Report results clearly. Check outbound and return legs separately. If nothing found, say so.

---

## On-demand cash price checks

**Rule: specific dates → SerpApi. Date ranges → fast-flights to find cheapest window.**

SerpApi returns real round-trip fares. fast-flights sums one-way legs and can diverge significantly on specific dates, but is fine for finding the cheapest window.

**SerpApi (specific dates):**

```bash
KEY=$(grep SERPAPI_KEY /workspace/project/.env | cut -d= -f2)
# Round-trip (type=1). travel_class: 1=economy, 2=premium economy, 3=business, 4=first
curl -s "https://serpapi.com/search.json?engine=google_flights\
&departure_id=SYD&arrival_id=BOS\
&outbound_date=2026-06-09&return_date=2026-07-15\
&currency=AUD&travel_class=2&type=1&adults=1\
&api_key=$KEY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if 'error' in data: print('ERROR:', data['error']); sys.exit(1)
for f in data.get('best_flights', []) + data.get('other_flights', []):
    legs = f.get('flights', [])
    airline = ', '.join(dict.fromkeys(l['airline'] for l in legs))
    dep = legs[0]['departure_airport']['time']
    arr = legs[-1]['arrival_airport']['time']
    via = [l['id'] for l in f.get('layovers', [])]
    dur = f['total_duration']
    print(f\"A\${f['price']} | {airline} | {dep}→{arr} | {len(legs)-1} stop via {via} | {dur//60}h{dur%60}m\")
"
```

`include_airlines=QF` to filter Qantas only. Omit `return_date` and set `type=2` for one-way. Free plan: 100 searches/month.

**fast-flights (date range sampling):**

```bash
python3 << 'EOF'
from fast_flights import FlightData, Passengers, TFSData
from fast_flights.core import get_flights_from_filter
from datetime import date, timedelta

def cheapest_in_range(origin, dest, date_from, date_to, seat, step=7):
    best = None
    d = date.fromisoformat(date_from)
    while d <= date.fromisoformat(date_to):
        try:
            r = get_flights_from_filter(
                TFSData.from_interface(
                    flight_data=[FlightData(date=d.isoformat(), from_airport=origin, to_airport=dest)],
                    trip="one-way", seat=seat, passengers=Passengers(adults=1),
                ),
                currency="AUD", mode="fallback",
            )
            for f in r.flights:
                try:
                    price = float(f.price.replace("A$","").replace(",",""))
                    if best is None or price < best[0]:
                        best = (price, d.isoformat(), f.name, f.stops == 0)
                except ValueError:
                    pass
        except Exception as e:
            print(f"  {d}: {e}")
        d += timedelta(days=step)
    return best  # (price, date, airline, is_direct)

seat = "premium-economy"  # or "economy", "business", "first"
ob = cheapest_in_range("SYD", "BOS", "2026-06-01", "2026-06-30", seat)
rt = cheapest_in_range("BOS", "SYD", "2026-07-01", "2026-07-31", seat)
if ob: print(f"Out cheapest: A${ob[0]:.0f} on {ob[1]} ({ob[2]}, {'direct' if ob[3] else '1+ stop'})")
if rt: print(f"Ret cheapest: A${rt[0]:.0f} on {rt[1]} ({rt[2]}, {'direct' if rt[3] else '1+ stop'})")
if ob and rt: print(f"Combined estimate: A${ob[0]+rt[0]:.0f} (one-way sum — confirm exact round-trip with SerpApi)")
EOF
```
