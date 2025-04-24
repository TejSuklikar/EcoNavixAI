import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

function App() {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [route, setRoute] = useState(null);
  const [routeData, setRouteData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [center, setCenter] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const userCoords = [position.coords.latitude, position.coords.longitude];
          setUserLocation(userCoords);
          setCenter(userCoords);

          reverseGeocode(userCoords[0], userCoords[1])
            .then(address => {
              console.log("Reverse geocoded address:", address);
              setOrigin(address);
            })
            .catch(error => console.error('Error getting address:', error));
        },
        (error) => {
          console.error('Error fetching location', error);
          setCenter([38.8977, -77.0365]); // Default to Washington DC
        }
      );
    }
  }, []);

  const reverseGeocode = async (lat, lon) => {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`,
        {
          headers: {
            'Accept-Language': 'en-US,en',
            'User-Agent': 'GreenRouteSolutions/1.0'
          }
        }
      );
      const data = await response.json();
      return data.display_name;
    } catch (error) {
      console.error('Reverse geocoding error:', error);
      return '';
    }
  };

  const geocode = async (address) => {
    try {
      const encodedAddress = encodeURIComponent(address);
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodedAddress}&limit=1`,
        {
          headers: {
            'Accept-Language': 'en-US,en',
            'User-Agent': 'GreenRouteSolutions/1.0'
          }
        }
      );
      const data = await response.json();

      if (data.length > 0) {
        return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
      }
      throw new Error('Address not found');
    } catch (error) {
      console.error('Geocoding error:', error);
      throw error;
    }
  };

  const validateAddress = (address) => {
    if (!address) return false;
    if (address.length < 5) return false;

    const hasLetters = /[a-zA-Z]/.test(address);
    const hasNumbers = /\d/.test(address);
    const hasComma = address.includes(',');
    const hasStateOrZip = /([A-Z]{2}|[0-9]{5})/.test(address);

    return hasLetters && (hasNumbers || hasComma || hasStateOrZip);
  };

  const fetchRoute = async () => {
    setLoading(true);
    setErrorMessage('');
    console.log("Fetching route for:", origin, "to", destination);

    if (!validateAddress(origin) || !validateAddress(destination)) {
      setErrorMessage('Please enter complete addresses for both origin and destination');
      setLoading(false);
      return;
    }

    try {
      const originCoords = await geocode(origin);
      const destinationCoords = await geocode(destination);

      const response = await fetch('/api/get_route_recommendation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin_coords: originCoords,
          destination_coords: destinationCoords,
          vehicle: {
            type: "gasoline_vehicle",
            model: "toyota_camry",
            efficiency: 15.0,
            fuel_type: "gasoline"
          }
        })
      });

      const data = await response.json();
      console.log("Route API response:", data);

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch route data');
      }

      setRouteData(data);
      setRoute(data.route);
      setErrorMessage('');
    } catch (error) {
      console.error('Error:', error);
      setErrorMessage(
        error.message === 'Address not found'
          ? 'Unable to find one or both addresses. Please provide complete addresses including city and state.'
          : 'Unable to compute route. Please ensure the addresses are valid and try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (minutes) => {
    if (!minutes && minutes !== 0) return 'N/A';
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = Math.round(minutes % 60);
    return hours > 0 ? `${hours} hr ${remainingMinutes} min` : `${remainingMinutes} min`;
  };

  const getEmissionsSaved = () => {
    if (!routeData?.comparison?.optimized?.carbon_emissions_kg) return 0;
    const original = routeData.comparison.original.carbon_emissions_kg;
    const optimized = routeData.comparison.optimized.carbon_emissions_kg;
    return original - optimized;
  };

  const RouteComparison = ({ comparison }) => {
    const kmToMiles = (km) => (km * 0.621371).toFixed(2);
    return (
      <div className="transparent-box route-comparison">
        <h2>Route Comparison</h2>
        <div className="comparison-grid">
          <div className="comparison-column">
            <h3>Original Route</h3>
            <div className="comparison-item">Distance: {kmToMiles(comparison.original.distance_km.toFixed(2))} miles</div>
            <div className="comparison-item">Time: {formatTime(comparison.original.duration_minutes)}</div>
            <div className="comparison-item">Emissions: {comparison.original.carbon_emissions_kg.toFixed(2)} kg CO₂</div>
          </div>
          <div className="comparison-column">
            <h3>Optimized Route</h3>
            <div className="comparison-item">Distance: {kmToMiles(comparison.optimized.distance_km.toFixed(2))} miles</div>
            <div className="comparison-item">Time: {formatTime(comparison.optimized.duration_minutes)}</div>
            <div className="comparison-item">Emissions: {comparison.optimized.carbon_emissions_kg.toFixed(2)} kg CO₂</div>
          </div>
        </div>
      </div>
    );
  };

  const DirectionsList = ({ directions }) => (
    <div className="transparent-box directions-list">
      <h2>Turn-by-Turn Directions</h2>
      <ol className="directions-items">
        {directions.map((direction, index) => (
          <li key={index}>{direction}</li>
        ))}
      </ol>
    </div>
  );

  const MapWithBounds = ({ route }) => {
    const map = useMap();
    useEffect(() => {
      if (route && route.length > 1) {
        const bounds = route.map((coord) => [coord[0], coord[1]]);
        map.fitBounds(bounds, { padding: [90, 100] });
      }
    }, [route, map]);
    return null;
  };

  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');

  useEffect(() => {
    if (isDarkMode) {
      document.body.classList.add('dark-mode');
      document.body.classList.remove('light-mode');
    } else {
      document.body.classList.add('light-mode');
      document.body.classList.remove('dark-mode');
    }
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  const toggleTheme = () => {
    setIsDarkMode((prevMode) => !prevMode);
  };

  return (
    <div className="App">
      <div className="header">
        <h1>EcoNavix</h1>
        <div className="subtitle">Optimizing routes for a sustainable future</div>
      </div>

      <button onClick={toggleTheme} className="theme-toggle">
        {isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      </button>

      <div className="transparent-box input-form">
        <div className="input-group">
          <label>Origin</label>
          <input
            type="text"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="Enter full address"
            disabled={loading}
          />
        </div>
        <div className="input-group">
          <label>Destination</label>
          <input
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="Enter full address"
            disabled={loading}
          />
        </div>
        <button 
          onClick={fetchRoute}
          disabled={loading || !origin || !destination}
          className={(!loading && origin && destination) ? 'active' : ''}
        >
          {loading ? 'Optimizing...' : 'Optimize Route'}
        </button>
      </div>

      {errorMessage && <div className="error-message">{errorMessage}</div>}

      <div className="map-container">
        {center && (
          <MapContainer center={center} zoom={13} style={{ height: '500px', width: '100%' }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="&copy; OpenStreetMap contributors"
            />
            <CircleMarker center={center} radius={8} fillColor="#008000" color="#008000" weight={2} opacity={0.8} fillOpacity={0.9} />
            {route && (
              <>
                <MapWithBounds route={route} />
                <Polyline positions={route} color="#00008B" weight={3} />
                <CircleMarker center={route[0]} radius={8} fillColor="#008000" color="#008000" weight={2} opacity={0.8} fillOpacity={0.9} />
                <CircleMarker center={route[route.length - 1]} radius={8} fillColor="#FF0000" color="#FF0000" weight={2} opacity={0.8} fillOpacity={0.9} />
              </>
            )}
          </MapContainer>
        )}
      </div>

      {routeData && (
        <div className="stats-container">
          <div className="transparent-box emissions-counter">
            <h2>Emissions Reduced</h2>
            <div className="emissions-value">
              {getEmissionsSaved().toFixed(2)}
            </div>
            <div className="emissions-unit">kg of CO₂</div>
          </div>

          {routeData.comparison && <RouteComparison comparison={routeData.comparison} />}
          {routeData.recommendation && (
            <div className="transparent-box recommendation">
              <h2>AI Recommendation</h2>
              <div className="recommendation-text">
                {routeData.recommendation.split(/\d+\.\s/).filter(Boolean).map((sentence, index) => (
                  <div key={index}>
                    {index + 1}. {sentence.trim()}
                    <br /><br />
                  </div>
                ))}
              </div>
            </div>
          )}
          {routeData.directions?.length > 0 && <DirectionsList directions={routeData.directions} />}
        </div>
      )}
    </div>
  );
}

export default App;
