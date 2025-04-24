import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helper: force Leaflet to pan whenever `center` state updates             */
/* ────────────────────────────────────────────────────────────────────────── */
function RecenterMap({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.setView(center);     //  you can use map.flyTo(center) if you prefer
  }, [center, map]);
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helper: Live location marker that updates with user position              */
/* ────────────────────────────────────────────────────────────────────────── */
function LiveLocationMarker({ position }) {
  return position ? (
    <CircleMarker 
      center={position} 
      radius={8} 
      fillColor="#008000" 
      color="#008000" 
      weight={2} 
      opacity={0.8} 
      fillOpacity={0.9} 
    />
  ) : null;
}

function App() {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [route, setRoute] = useState(null);
  const [routeData, setRouteData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [center, setCenter] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const watchIdRef = useRef(null);

  /* ------------------------------------------------------------------ */
  /*  1.  Get and watch browser location                                */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    // Initial location fetch
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async ({ coords }) => {
          const pos = [coords.latitude, coords.longitude];
          console.log('Got user position:', pos);
          setUserLocation(pos);
          setCenter(pos);
          try {
            const addr = await reverseGeocode(pos[0], pos[1]);
            console.log('Reverse geocoded address:', addr);
            setOrigin(addr);
          } catch (e) {
            console.error('Error reverse-geocoding current position', e);
          }
        },
        (err) => {
          console.error("Geolocation error:", err);
          setCenter([38.8977, -77.0365]); // default: Washington DC
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );

      // Start watching position changes
      watchIdRef.current = navigator.geolocation.watchPosition(
        ({ coords }) => {
          const pos = [coords.latitude, coords.longitude];
          console.log('Position updated:', pos);
          setUserLocation(pos);
          // Only update center if we're not actively viewing a route
          if (!route) {
            setCenter(pos);
          }
        },
        (err) => console.error("Geolocation watch error:", err),
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
      );
    } else {
      console.error('Geolocation not supported by this browser');
    }

    // Clean up the watcher when component unmounts
    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        console.log('Cleared geolocation watch');
      }
    };
  }, [route]);

  /* ------------------------------------------------------------------ */
  /*  2.  Geocode helpers (OpenCage)                                    */
  /* ------------------------------------------------------------------ */
  const reverseGeocode = async (lat, lon) => {
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) return 'Invalid location';
    // Use direct API key instead of environment variable
    const apiKey = "8e18b2a216ea4d64b87b8323cd7b2f08";
    try {
      console.log(`Attempting to reverse geocode: ${lat}, ${lon}`);
      const res = await fetch(
        `https://api.opencagedata.com/geocode/v1/json?q=${lat}+${lon}&key=${apiKey}`
      );
      
      if (!res.ok) {
        console.error(`OpenCage API error: ${res.status} ${res.statusText}`);
        return 'Error getting location';
      }
      
      const data = await res.json();
      console.log('OpenCage API response:', data);
      
      if (data.results && data.results.length > 0) {
        return data.results[0].formatted;
      } else {
        console.error('No results found in OpenCage response');
        return 'Unknown location';
      }
    } catch (error) {
      console.error('Error in reverse geocoding:', error);
      return 'Unknown location';
    }
  };

  const geocode = async (address) => {
    // Use direct API key instead of environment variable
    const apiKey = "8e18b2a216ea4d64b87b8323cd7b2f08";
    try {
      console.log(`Attempting to geocode address: ${address}`);
      const res = await fetch(
        `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${apiKey}`
      );
      
      if (!res.ok) {
        console.error(`OpenCage API error: ${res.status} ${res.statusText}`);
        throw new Error('Geocoding API error');
      }
      
      const data = await res.json();
      console.log('OpenCage geocode response:', data);
      
      if (data.results?.length) {
        const { lat, lng } = data.results[0].geometry;
        console.log(`Found coordinates: ${lat}, ${lng}`);
        return [lat, lng];
      }
      
      console.error('No results found in geocode response');
      throw new Error('Address not found');
    } catch (error) {
      console.error('Error in geocoding:', error);
      throw error;
    }
  };

  const validateAddress = (addr) =>
    !!addr &&
    addr.length >= 5 &&
    /[a-zA-Z]/.test(addr) &&
    (/\d/.test(addr) || addr.includes(',') || /([A-Z]{2}|[0-9]{5})/.test(addr));

  /* ------------------------------------------------------------------ */
  /*  3.  Fetch route from backend                                      */
  /* ------------------------------------------------------------------ */
  const fetchRoute = async () => {
    setLoading(true);
    setErrorMessage('');

    if (!validateAddress(origin) || !validateAddress(destination)) {
      setErrorMessage('Please enter complete addresses for both origin and destination');
      setLoading(false);
      return;
    }

    try {
      console.log('Geocoding origin:', origin);
      const originCoords = await geocode(origin);
      
      console.log('Geocoding destination:', destination);
      const destinationCoords = await geocode(destination);

      console.log('Setting map center to origin coordinates');
      setCenter(originCoords);

      console.log('Sending route request to backend');
      const res = await fetch('http://localhost:5050/get_route_recommendation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin_coords: originCoords,
          destination_coords: destinationCoords,
          vehicle: {
            type: 'gasoline_vehicle',
            model: 'toyota_camry',
            efficiency: 15.0,
            fuel_type: 'gasoline',
          },
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        console.error('Error response from backend:', errorData);
        throw new Error(errorData.error || 'Failed to fetch route data');
      }

      const data = await res.json();
      console.log('Received route data:', data);
      
      setRoute(data.route);
      setRouteData(data);
    } catch (err) {
      console.error('Error in fetchRoute:', err);
      setErrorMessage(
        err.message === 'Address not found'
          ? 'Unable to find one or both addresses. Please provide complete addresses including city and state.'
          : 'Unable to compute route. Please ensure the addresses are valid and try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  /* ------------------------------------------------------------------ */
  /*  4.  UI helpers                                                    */
  /* ------------------------------------------------------------------ */
  const formatTime = (m) =>
    m || m === 0
      ? Math.floor(m / 60) > 0
        ? `${Math.floor(m / 60)} hr ${Math.round(m % 60)} min`
        : `${Math.round(m)} min`
      : 'N/A';

  const getEmissionsSaved = () =>
    routeData?.comparison?.optimized?.carbon_emissions_kg
      ? routeData.comparison.original.carbon_emissions_kg -
        routeData.comparison.optimized.carbon_emissions_kg
      : 0;

  const RouteComparison = ({ comparison }) => {
    const kmToMiles = (km) => (km * 0.621371).toFixed(2);
    return (
      <div className="transparent-box route-comparison">
        <h2>Route Comparison</h2>
        <div className="comparison-grid">
          {['original', 'optimized'].map((key) => (
            <div className="comparison-column" key={key}>
              <h3>{key === 'original' ? 'Original Route' : 'Optimized Route'}</h3>
              <div className="comparison-item">
                Distance: {kmToMiles(comparison[key].distance_km.toFixed(2))} miles
              </div>
              <div className="comparison-item">
                Time: {formatTime(comparison[key].duration_minutes)}
              </div>
              <div className="comparison-item">
                Emissions: {comparison[key].carbon_emissions_kg.toFixed(2)} kg CO₂
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const DirectionsList = ({ directions }) => (
    <div className="transparent-box directions-list">
      <h2>Turn-by-Turn Directions</h2>
      <ol className="directions-items">
        {directions.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ol>
    </div>
  );

  const MapWithBounds = ({ route }) => {
    const map = useMap();
    useEffect(() => {
      if (route?.length > 1) map.fitBounds(route.map((c) => [c[0], c[1]]), { padding: [90, 100] });
    }, [route, map]);
    return null;
  };

  /* ------------------------------------------------------------------ */
  /*  5.  Theme toggle                                                  */
  /* ------------------------------------------------------------------ */
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
  useEffect(() => {
    document.body.classList.toggle('dark-mode', isDarkMode);
    document.body.classList.toggle('light-mode', !isDarkMode);
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  /* ------------------------------------------------------------------ */
  /*  6.  JSX                                                           */
  /* ------------------------------------------------------------------ */
  return (
    <div className="App">
      <header className="header">
        <h1>EcoNavix</h1>
        <div className="subtitle">Optimizing routes for a sustainable future</div>
      </header>

      <button onClick={() => setIsDarkMode((m) => !m)} className="theme-toggle">
        {isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      </button>

      <section className="transparent-box input-form">
        <div className="input-group">
          <label>ORIGIN</label>
          <input
            type="text"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="Enter full address"
            disabled={loading}
          />
        </div>
        <div className="input-group">
          <label>DESTINATION</label>
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
          className={!loading && origin && destination ? 'active' : ''}
        >
          {loading ? 'Optimizing…' : 'Optimize Route'}
        </button>
      </section>

      {errorMessage && <div className="error-message">{errorMessage}</div>}

      <div className="map-container">
        {center && (
          <MapContainer center={center} zoom={13} style={{ height: '500px', width: '100%' }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="&copy; OpenStreetMap contributors"
            />

            <RecenterMap center={center} />

            {/* Always show user's current location */}
            <LiveLocationMarker position={userLocation} />

            {route && (
              <>
                <MapWithBounds route={route} />
                <Polyline positions={route} color="#00008B" weight={3} />
                {/* Origin marker (green) */}
                <CircleMarker center={route[0]} radius={8} fillColor="#008000" color="#008000" weight={2} opacity={0.8} fillOpacity={0.9} />
                {/* Destination marker (red) */}
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
            <div className="emissions-value">{getEmissionsSaved().toFixed(2)}</div>
            <div className="emissions-unit">kg of CO₂</div>
          </div>

          {routeData.comparison && <RouteComparison comparison={routeData.comparison} />}
          {routeData.recommendation && (
            <div className="transparent-box recommendation">
              <h2>AI Recommendation</h2>
              <div className="recommendation-text">
                {routeData.recommendation
                  .split(/\d+\.\s/)
                  .filter(Boolean)
                  .map((s, i) => (
                    <div key={i}>
                      {i + 1}. {s.trim()}
                      <br />
                      <br />
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