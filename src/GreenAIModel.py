"""
EcoNavix ‒ Flask backend
• Secrets are now read once from environment variables (.env for local dev, Vercel env vars in prod)
• No API keys are accepted from the client any more
"""

import os
import json
import requests
import openai
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv   # ← NEW

# ---------------------------------------------------------------------------
#  Bootstrap
# ---------------------------------------------------------------------------
load_dotenv()                     # reads .env in local development

EIA_API_KEY              = os.getenv("EIA_API_KEY")
CARBON_INTERFACE_API_KEY = os.getenv("CARBON_INTERFACE_API_KEY")
WEATHER_API_KEY          = os.getenv("WEATHER_API_KEY")
OPENROUTESERVICE_API_KEY = os.getenv("OPENROUTESERVICE_API_KEY")
OPENAI_API_KEY           = os.getenv("OPENAI_API_KEY")

openai.api_key = OPENAI_API_KEY   # set once, globally

app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
#  Helper functions (unchanged, except they no longer hard-set OpenAI key)
# ---------------------------------------------------------------------------
def get_energy_data(eia_key):
    try:
        url = (
            "https://api.eia.gov/v2/petroleum/pri/gnd/data/"
            f"?frequency=weekly&data[0]=value&sort[0][column]=period"
            f"&sort[0][direction]=desc&offset=0&length=5000&api_key={eia_key}"
        )
        r = requests.get(url)
        if r.status_code == 200:
            latest = r.json()['response']['data'][0]
            return {"price_per_gallon": latest['value'], "period": latest['period']}
        print("EIA error:", r.status_code, r.text)
    except Exception as e:
        print("get_energy_data:", e)
    return None


def calculate_emissions(distance_km, carbon_key):
    try:
        headers = {"Authorization": f"Bearer {carbon_key}", "Content-Type": "application/json"}
        payload = {
            "type": "vehicle",
            "distance_unit": "km",
            "distance_value": distance_km,
            "vehicle_model_id": "7268a9b7-17e8-4c8d-acca-57059252afe9"
        }
        r = requests.post("https://www.carboninterface.com/api/v1/estimates", headers=headers, json=payload)
        if r.status_code == 201:
            g = r.json()['data']['attributes']['carbon_g']
            return {"carbon_g": g, "carbon_kg": g / 1000}
        print("Carbon API error:", r.status_code, r.text)
    except Exception as e:
        print("calculate_emissions:", e)
    return None


def get_weather_data(location, wx_key):
    try:
        url = f"http://api.openweathermap.org/data/2.5/weather?q={location}&appid={wx_key}&units=metric"
        r = requests.get(url)
        if r.status_code == 200:
            d = r.json()
            return {
                "temperature": d['main']['temp'],
                "weather": d['weather'][0]['description'],
                "wind_speed": d['wind']['speed']
            }
        print("Weather error:", r.status_code, r.text)
    except Exception as e:
        print("get_weather_data:", e)
    return None


def get_eco_route(origin, dest, ors_key):
    try:
        origin_fmt = [origin[1], origin[0]]           # [lon, lat]
        dest_fmt   = [dest[1],   dest[0]]
        headers = {"Authorization": ors_key, "Content-Type": "application/json"}
        payload = {"coordinates": [origin_fmt, dest_fmt], "profile": "driving-car"}
        r = requests.post("https://api.openrouteservice.org/v2/directions/driving-car/geojson",
                          headers=headers, json=payload)
        if r.status_code != 200:
            print("ORS error:", r.status_code, r.text)
            return None

        feat = r.json()['features'][0]
        coords = feat['geometry']['coordinates']
        props  = feat['properties']
        return {
            "distance_km": props['segments'][0]['distance'] / 1000,
            "duration_minutes": round(props['segments'][0]['duration'] / 60),
            "coordinates": [[c[1], c[0]] for c in coords],    # lat, lon for Leaflet
            "directions":
                [step['instruction'] for seg in props['segments'] for step in seg.get('steps', [])
                 if 'instruction' in step]
        }
    except Exception as e:
        print("get_eco_route:", e)
    return None


def simulate_optimized_route(route):
    return {
        "optimized_distance_km": route["distance_km"],
        "optimized_duration_minutes": round(route["duration_minutes"] * 0.95),
        "optimized_carbon_emissions": {"carbon_kg": route["emissions"]["carbon_kg"] * 0.9}
    }


def generate_openai_prompt(route, energy, emissions, wx_orig, wx_dest, vehicle):
    return (
        "Based on the following information:\n"
        f"- Distance: {route['distance_km']} km\n"
        f"- Estimated Time: {route['duration_minutes']} minutes\n"
        f"- Energy Price: ${energy['price_per_gallon']} per gallon\n"
        f"- Estimated Carbon Emissions: {emissions['carbon_kg']:.2f} kg of CO₂\n"
        f"- Weather at Origin: {wx_orig['weather']}, "
        f"Temperature: {wx_orig['temperature']}°C, Wind: {wx_orig['wind_speed']} m/s\n"
        f"- Weather at Destination: {wx_dest['weather']}, "
        f"Temperature: {wx_dest['temperature']}°C, Wind: {wx_dest['wind_speed']} m/s\n"
        f"- Vehicle Type: {vehicle['type']}, "
        f"Fuel Efficiency: {vehicle['efficiency']} km/l, Fuel: {vehicle['fuel_type']}\n"
        "Provide a recommendation for reducing emissions and optimizing energy consumption "
        "for this route. Don’t number the first line; subsequent items should be indented and numbered."
    )


def get_openai_recommendation(prompt):
    try:
        r = openai.ChatCompletion.create(
            model="gpt-4",
            messages=[{"role": "system", "content": "You are an AI assistant that provides route and energy optimization advice."},
                      {"role": "user",   "content": prompt}],
            max_tokens=200,
            temperature=0.7,
        )
        return r['choices'][0]['message']['content'].strip()
    except Exception as e:
        print("OpenAI error:", e)
        return "Failed to generate recommendation."


# ---------------------------------------------------------------------------
#  API endpoint
# ---------------------------------------------------------------------------
@app.route("/get_route_recommendation", methods=["POST"])
def get_route_recommendation():
    try:
        data = request.json
        origin_coords      = data.get("origin_coords")
        destination_coords = data.get("destination_coords")
        vehicle            = data.get("vehicle")

        if not origin_coords or not destination_coords:
            return jsonify({"error": "Both origin_coords and destination_coords must be provided."}), 400

        route_data = get_eco_route(origin_coords, destination_coords, OPENROUTESERVICE_API_KEY)
        if route_data is None:
            return jsonify({"error": "Unable to calculate route with provided coordinates."}), 400

        energy_data = get_energy_data(EIA_API_KEY) or {"price_per_gallon": 0, "period": "N/A"}
        weather_origin = get_weather_data("San Francisco", WEATHER_API_KEY) or \
                         {"temperature": 20, "weather": "clear", "wind_speed": 5}
        weather_dest   = get_weather_data("Los Angeles", WEATHER_API_KEY) or \
                         {"temperature": 25, "weather": "clear", "wind_speed": 5}

        carbon = calculate_emissions(route_data["distance_km"], CARBON_INTERFACE_API_KEY) or \
                 {"carbon_g": route_data["distance_km"] * 2310, "carbon_kg": route_data["distance_km"] * 2.31}
        route_data["emissions"] = carbon

        optimized = simulate_optimized_route(route_data)
        prompt    = generate_openai_prompt(route_data, energy_data, carbon, weather_origin, weather_dest, vehicle)
        advice    = get_openai_recommendation(prompt)

        comparison = {
            "original": {
                "distance_km": route_data["distance_km"],
                "duration_minutes": route_data["duration_minutes"],
                "carbon_emissions_kg": carbon["carbon_kg"],
            },
            "optimized": {
                "distance_km": optimized["optimized_distance_km"],
                "duration_minutes": optimized["optimized_duration_minutes"],
                "carbon_emissions_kg": optimized["optimized_carbon_emissions"]["carbon_kg"],
            },
        }

        return jsonify({
            "route": route_data["coordinates"],
            "directions": route_data["directions"],
            "comparison": comparison,
            "recommendation": advice,
        })

    except Exception as e:
        print("Route endpoint error:", e)
        return jsonify({"error": f"Internal server error: {e}"}), 500


if __name__ == "__main__":
    # Local dev only
    app.run(host="0.0.0.0", port=5050, debug=True)
