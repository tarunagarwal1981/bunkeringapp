import React, { useState, useMemo, useEffect, useRef } from "react";
import "./App.css";
import VesselSelection from "./components/VesselSelection";
import SyncStatus from "./components/SyncStatus";
import Settings from "./components/Settings";
import { getCompartments, hasVesselData, getVesselInfo } from "./db/database";
import { calculateSounding } from "./utils/interpolation";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { v4 as uuidv4 } from "uuid";
import { getLambdaUrl, saveLambdaUrl, logConfig } from "./config";
import { requestPersistentStorage, estimateStorage, formatBytes } from "./utils/storage";
import { usePackageUpdateChecker } from "./hooks/usePackageUpdateChecker";
import AdminPanel from "./components/AdminPanel";

function App() {
  // Connection and compartments
  // Initialize from deep link first, then fallback to saved/env
  const searchParams = new URLSearchParams(window.location.search);
  const lambdaFromQuery = searchParams.get('lambda');
  const vesselFromQuery = searchParams.get('vesselId');
  const installFromQuery = searchParams.get('install');
  if (lambdaFromQuery) {
    try { saveLambdaUrl(new URL(lambdaFromQuery).toString()); } catch {}
  }
  const [lambdaUrl, setLambdaUrl] = useState(() => (lambdaFromQuery || getLambdaUrl() || ""));
  const [connected, setConnected] = useState(true);
  const initialInstallRan = useRef(false);
  const [compartments, setCompartments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [vesselSelected, setVesselSelected] = useState(false);
  const [currentVessel, setCurrentVessel] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

  const isOnline = useOnlineStatus();
  const fuelGrades = ["HSFO", "VLSFO", "ULSFO", "LSMGO", "MGO", "BIOFUEL"];
  
  // Submit state
  const [submitStatus, setSubmitStatus] = useState({ message: "", type: "" });

  // Sounding tab state
  const [activeTab, setActiveTab] = useState("sounding");
  const [reportDate, setReportDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [globalTrim, setGlobalTrim] = useState("");
  const [globalHeel, setGlobalHeel] = useState("");
  const [tankEntries, setTankEntries] = useState([
    {
      id: Date.now(),
      compartment_id: "",
      fuel_grade: "",
      ullage: "",
      density: "",
      temp: "",
      result: null,
      loading: false,
      error: "",
    },
  ]);

  // Bunkering tab state
  const [numBunkers, setNumBunkers] = useState(1);
  const [bunkeringData, setBunkeringData] = useState([
    {
      id: 1,
      name: "Bunker 1",
      density: "",
      temp: "",
      totalQtyMT: "",
      heel: "",
      trim: "",
      entries: [
        {
          id: Date.now(),
          timestamp: new Date().toISOString().slice(0, 16),
          compartment_id: "",
          ullage: "",
          result: null,
          loading: false,
          error: "",
        },
      ],
    },
  ]);

  // Check for vessel data on mount and log configuration
  useEffect(() => {
    logConfig(); // Log app configuration
    // Request persistent storage and log storage estimate
    (async () => {
      const persistence = await requestPersistentStorage();
      const estimate = await estimateStorage();
      if (persistence.supported) {
        console.log(`Storage persistence: ${persistence.persisted ? 'granted' : 'not granted'}`);
      }
      if (estimate.supported) {
        const quota = estimate.quota ? formatBytes(estimate.quota) : 'unknown';
        const usage = estimate.usage ? formatBytes(estimate.usage) : 'unknown';
        console.log(`Storage usage: ${usage} / ${quota}`);
      }
    })();
    // Deep link handling: run once after mount if params present
    (async () => {
      if (initialInstallRan.current) return;
      initialInstallRan.current = true;
      await checkVesselData();
      if (lambdaFromQuery && vesselFromQuery && installFromQuery === '1') {
        try {
          const { downloadVesselDataPackage } = await import('./db/dataPackageService');
          await downloadVesselDataPackage(lambdaFromQuery || lambdaUrl, vesselFromQuery);
          const vessel = await getVesselInfo();
          setCurrentVessel(vessel);
          setVesselSelected(true);
          await loadCompartmentsFromDB();
        } catch (e) {
          console.error('Deep link install failed:', e);
        }
      }
    })();
  }, []);

  // Background package update checker
  const { updateInfo, dismiss } = usePackageUpdateChecker({
    lambdaUrl,
    vessel: currentVessel,
    intervalMs: 5 * 60 * 1000
  });

  const installUpdateNow = async () => {
    if (!currentVessel) return;
    try {
      setInstallingUpdate(true);
      const { downloadVesselDataPackage } = await import('./db/dataPackageService');
      await downloadVesselDataPackage(lambdaUrl, currentVessel.vessel_id);
      const vessel = await getVesselInfo();
      setCurrentVessel(vessel);
      await loadCompartmentsFromDB();
      dismiss();
    } catch (e) {
      console.error('Update install failed:', e);
    } finally {
      setInstallingUpdate(false);
    }
  };

  async function checkVesselData() {
    const hasData = await hasVesselData();
    if (hasData) {
      const vessel = await getVesselInfo();
      setCurrentVessel(vessel);
      setVesselSelected(true);
      await loadCompartmentsFromDB();
    }
  }

  async function loadCompartmentsFromDB() {
    try {
      const comps = await getCompartments();
      setCompartments(comps);
      console.log(`✓ Loaded ${comps.length} compartments from local database`);
    } catch (err) {
      console.error("Error loading compartments:", err);
    }
  }

  // Connect to Lambda
  const connectToLambda = async () => {
    if (!lambdaUrl.trim()) {
      setError("Please enter Lambda Function URL");
      return;
    }
    setLoading(true);
    setError("");
    try {
      // Validate URL format
      const url = new URL(lambdaUrl);
      if (!url.protocol.startsWith('http')) {
        throw new Error("Invalid URL protocol");
      }
      
      // Save to localStorage for future use
      saveLambdaUrl(lambdaUrl);
      
      setConnected(true);
      setError("");
      console.log("✓ Lambda URL saved:", lambdaUrl);
    } catch (err) {
      setError("Invalid URL: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVesselSelected = async (vessel) => {
    setCurrentVessel(vessel);
    setVesselSelected(true);
    await loadCompartmentsFromDB();
  };

  const handleLambdaUrlUpdated = (newUrl) => {
    setLambdaUrl(newUrl);
    console.log("✓ Lambda URL updated from settings:", newUrl);
  };

  const resetConnection = () => {
    // Go back to vessel selection screen
    setVesselSelected(false);
    setCurrentVessel(null);
    setCompartments([]);
    setTankEntries([{
      id: Date.now(),
      compartment_id: "",
      fuel_grade: "",
      ullage: "",
      density: "",
      temp: "",
      result: null,
      loading: false,
      error: "",
    }]);
  };

  // Submit soundings to cloud (with summary data)
  const submitSoundingsToCloud = async () => {
    if (!isOnline) {
      setSubmitStatus({
        message: "Cannot submit: You are offline",
        type: "error",
      });
      setTimeout(() => setSubmitStatus({ message: "", type: "" }), 3000);
      return;
    }

    // Filter tank entries that have results
    const completedSoundings = tankEntries.filter(
      (entry) => entry.result && entry.result.success && entry.compartment_id && entry.fuel_grade
    );

    if (completedSoundings.length === 0) {
      setSubmitStatus({
        message: "No completed calculations to submit",
        type: "error",
      });
      setTimeout(() => setSubmitStatus({ message: "", type: "" }), 3000);
      return;
    }

    try {
      setSubmitStatus({ message: "Submitting...", type: "loading" });

      // Generate a session ID to group all soundings together
      const sessionId = uuidv4();
      const systemTimestamp = new Date().toISOString();

      // Prepare individual tank soundings with session ID
      const soundingsPayload = completedSoundings.map((entry) => {
        const compartmentName = compartments.find(
          (c) => c.compartment_id === parseInt(entry.compartment_id)
        )?.compartment_name || "Unknown";

        return {
          client_id: uuidv4(),
          session_id: sessionId, // Group all soundings together
          compartment_id: parseInt(entry.compartment_id),
          compartment_name: compartmentName,
          recorded_at: systemTimestamp, // System date/time
          report_date: reportDate, // User-selected date
          ullage: parseFloat(entry.ullage),
          trim: parseFloat(globalTrim),
          heel: globalHeel !== "" ? parseFloat(globalHeel) : null,
          fuel_grade: entry.fuel_grade,
          density: entry.density ? parseFloat(entry.density) : null,
          temperature: entry.temp ? parseFloat(entry.temp) : null,
          base_volume: parseFloat(entry.result.base_volume || entry.result.volume),
          heel_correction: parseFloat(entry.result.heel_correction || 0),
          final_volume: parseFloat(entry.result.final_volume || entry.result.volume),
          calculated_mt: entry.density
            ? parseFloat(entry.result.final_volume || entry.result.volume) * parseFloat(entry.density)
            : null,
          user_name: null,
          device_info: navigator.userAgent,
          app_version: "1.0.0",
        };
      });

      // Prepare summary data (total mass by fuel grade)
      const summaryData = {
        session_id: sessionId,
        recorded_at: systemTimestamp,
        report_date: reportDate,
        total_tanks: completedSoundings.length,
        total_mass_by_fuel_grade: totalMtByFuelGrade,
        grand_total_mt: Object.values(totalMtByFuelGrade).reduce((sum, mt) => sum + mt, 0),
        trim: parseFloat(globalTrim),
        heel: globalHeel !== "" ? parseFloat(globalHeel) : null,
      };

      const payload = {
        soundings: soundingsPayload,
        summary: summaryData,
      };

      const normalizedUrl = lambdaUrl.replace(/\/+$/, "");
      const response = await fetch(
        `${normalizedUrl}/vessel/${currentVessel.vessel_id}/sync-soundings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      setSubmitStatus({
        message: `✅ Saved ${result.inserted} tank(s) + summary to cloud at ${new Date(systemTimestamp).toLocaleString()}`,
        type: "success",
      });

      console.log("✓ Soundings submitted:", result);
      console.log("✓ Session ID:", sessionId);
      console.log("✓ Summary:", summaryData);

      // Keep form data - DO NOT clear or refresh
      setTimeout(() => setSubmitStatus({ message: "", type: "" }), 5000);
    } catch (err) {
      console.error("Error submitting soundings:", err);
      setSubmitStatus({
        message: `❌ Failed to submit: ${err.message}`,
        type: "error",
      });
      setTimeout(() => setSubmitStatus({ message: "", type: "" }), 5000);
    }
  };

  // SOUNDING TAB LOGIC
  const updateTankEntry = (index, updates) => {
    setTankEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, ...updates } : entry))
    );
  };

  const addTankRow = () => {
    setTankEntries((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        compartment_id: "",
        fuel_grade: "",
        ullage: "",
        density: "",
        temp: "",
        result: null,
        loading: false,
        error: "",
      },
    ]);
  };

  const removeTankRow = (idToRemove) => {
    setTankEntries((prev) => prev.filter((entry) => entry.id !== idToRemove));
  };

  const fetchSoundingData = async (index) => {
    const entry = tankEntries[index];
    if (!entry.compartment_id || entry.ullage === "" || globalTrim === "") {
      updateTankEntry(index, {
        error: "Please select tank, enter ullage, and set global trim",
      });
      return;
    }
    
    updateTankEntry(index, { loading: true, error: "", result: null });
    
    try {
      // Use offline interpolation
      const result = await calculateSounding(
        parseInt(entry.compartment_id),
        parseFloat(entry.ullage),
        parseFloat(globalTrim),
        globalHeel !== "" ? parseFloat(globalHeel) : null
      );
      
      if (result.success) {
        updateTankEntry(index, { result: result, error: "" });
      } else {
        updateTankEntry(index, {
          error: result.error || "Calculation failed",
          result: null,
        });
      }
    } catch (err) {
      updateTankEntry(index, {
        error: "Calculation error: " + err.message,
        result: null,
      });
    } finally {
      updateTankEntry(index, { loading: false });
    }
  };

  const formatVolumeDisplay = (result) => {
    if (!result) return "N/A";
    const displayVolume =
      result.final_volume !== undefined ? result.final_volume : result.volume;
    if (result.heel_correction !== undefined && result.heel_correction !== 0) {
      return (
        <div className="volume-with-heel">
          <div className="base-volume">
            Base: {parseFloat(result.base_volume).toFixed(2)}
          </div>
          <div className="heel-correction">
            Heel: {result.heel_correction > 0 ? "+" : ""}
            {parseFloat(result.heel_correction).toFixed(2)}
          </div>
          <div className="final-volume">
            <strong>Final: {parseFloat(displayVolume).toFixed(2)}</strong>
          </div>
        </div>
      );
    }
    return parseFloat(displayVolume).toFixed(2);
  };

  const calculateMT = (result, density) => {
    if (!result || !density || isNaN(parseFloat(density))) return "N/A";
    const volume =
      result.final_volume !== undefined ? result.final_volume : result.volume;
    if (isNaN(parseFloat(volume))) return "N/A";
    return (parseFloat(volume) * parseFloat(density)).toFixed(2);
  };

  const totalMtByFuelGrade = useMemo(() => {
    const totals = {};
    tankEntries.forEach((entry) => {
      if (entry.fuel_grade && entry.result && entry.density) {
        const mt = parseFloat(calculateMT(entry.result, entry.density));
        if (!isNaN(mt)) {
          totals[entry.fuel_grade] = (totals[entry.fuel_grade] || 0) + mt;
        }
      }
    });
    return totals;
  }, [tankEntries]);

  // BUNKERING TAB LOGIC
  const updateBunkerData = (bunkerIndex, updates) => {
    setBunkeringData((prev) =>
      prev.map((bunker, i) =>
        i === bunkerIndex ? { ...bunker, ...updates } : bunker
      )
    );
  };

  const addBunkeringEntry = (bunkerIndex) => {
    const newEntry = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString().slice(0, 16),
      compartment_id: "",
      ullage: "",
      result: null,
      loading: false,
      error: "",
    };
    const currentBunker = bunkeringData[bunkerIndex];
    updateBunkerData(bunkerIndex, {
      entries: [...currentBunker.entries, newEntry],
    });
  };

  const updateBunkeringEntry = (bunkerIndex, entryIndex, updates) => {
    setBunkeringData((prev) =>
      prev.map((bunker, i) =>
        i === bunkerIndex
          ? {
              ...bunker,
              entries: bunker.entries.map((entry, j) =>
                j === entryIndex ? { ...entry, ...updates } : entry
              ),
            }
          : bunker
      )
    );
  };

  const removeBunkeringEntry = (bunkerIndex, entryId) => {
    const currentBunker = bunkeringData[bunkerIndex];
    const updatedEntries = currentBunker.entries.filter(
      (entry) => entry.id !== entryId
    );
    updateBunkerData(bunkerIndex, { entries: updatedEntries });
  };

  const fetchBunkeringData = async (bunkerIndex, entryIndex) => {
    const bunker = bunkeringData[bunkerIndex];
    const entry = bunker.entries[entryIndex];
    
    const isValidCompartment =
      entry.compartment_id && entry.compartment_id.toString().trim() !== "";
    const isValidUllage =
      entry.ullage !== "" &&
      entry.ullage !== null &&
      entry.ullage !== undefined &&
      entry.ullage.toString().trim() !== "";
    const isValidTrim =
      bunker.trim !== "" &&
      bunker.trim !== null &&
      bunker.trim !== undefined &&
      bunker.trim.toString().trim() !== "";
      
    if (!isValidCompartment || !isValidUllage || !isValidTrim) {
      const missingFields = [];
      if (!isValidCompartment) missingFields.push("tank");
      if (!isValidUllage) missingFields.push("ullage");
      if (!isValidTrim) missingFields.push("trim");
      updateBunkeringEntry(bunkerIndex, entryIndex, {
        error: `Please provide: ${missingFields.join(", ")}`,
      });
      return;
    }
    
    updateBunkeringEntry(bunkerIndex, entryIndex, {
      loading: true,
      error: "",
      result: null,
    });
    
    try {
      // Use offline interpolation
      const result = await calculateSounding(
        parseInt(entry.compartment_id),
        parseFloat(entry.ullage),
        parseFloat(bunker.trim),
        bunker.heel && bunker.heel.toString().trim() !== "" ? parseFloat(bunker.heel) : null
      );
      
      if (result.success) {
        updateBunkeringEntry(bunkerIndex, entryIndex, {
          result: result,
          error: "",
        });
      } else {
        updateBunkeringEntry(bunkerIndex, entryIndex, {
          error: result.error || "Calculation failed",
          result: null,
        });
      }
    } catch (err) {
      updateBunkeringEntry(bunkerIndex, entryIndex, {
        error: "Calculation error: " + err.message,
        result: null,
      });
    } finally {
      updateBunkeringEntry(bunkerIndex, entryIndex, { loading: false });
    }
  };

  const calculateBunkeringMetrics = (bunker, entry) => {
    if (!entry.result || !bunker.density || bunker.density === "") return null;
    try {
      const volume =
        entry.result.final_volume !== undefined
          ? parseFloat(entry.result.final_volume)
          : parseFloat(entry.result.volume);
      const density = parseFloat(bunker.density);
      if (isNaN(volume) || isNaN(density)) return null;
      const mt = volume * density;
      const selectedTank = compartments.find(
        (comp) => comp.compartment_id === parseInt(entry.compartment_id)
      );
      const tankCapacity = selectedTank?.capacity || 1000;
      const percentFull = (volume / tankCapacity) * 100;
      return {
        volume: volume.toFixed(2),
        mt: mt.toFixed(2),
        percentFull: Math.min(percentFull, 100).toFixed(1),
      };
    } catch {
      return null;
    }
  };

  const updateNumBunkers = (num) => {
    setNumBunkers(num);
    const newBunkeringData = [];
    for (let i = 0; i < num; i++) {
      if (bunkeringData[i]) {
        newBunkeringData.push(bunkeringData[i]);
      } else {
        newBunkeringData.push({
          id: i + 1,
          name: `Bunker ${i + 1}`,
          density: "",
          temp: "",
          totalQtyMT: "",
          heel: "",
          trim: "",
          entries: [
            {
              id: Date.now() + i,
              timestamp: new Date().toISOString().slice(0, 16),
              compartment_id: "",
              ullage: "",
              result: null,
              loading: false,
              error: "",
            },
          ],
        });
      }
    }
    setBunkeringData(newBunkeringData);
  };

  const isCalculationEnabled = (bunker, entry) => {
    const hasCompartment =
      entry.compartment_id && entry.compartment_id.toString().trim() !== "";
    const hasUllage =
      entry.ullage !== "" &&
      entry.ullage !== null &&
      entry.ullage !== undefined &&
      entry.ullage.toString().trim() !== "";
    const hasTrim =
      bunker.trim !== "" &&
      bunker.trim !== null &&
      bunker.trim !== undefined &&
      bunker.trim.toString().trim() !== "";
    return hasCompartment && hasUllage && hasTrim && !entry.loading;
  };

  // UI
  // Connection screen removed: app starts directly

  if (!vesselSelected) {
    return (
      <div className="app">
        <div className="main-container">
          <VesselSelection 
            lambdaUrl={lambdaUrl} 
            onVesselSelected={handleVesselSelected}
            disableAutoSelect={true}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="main-container">
        {currentVessel && updateInfo && (
          <div className="sync-status-bar" style={{ marginBottom: 8 }}>
            <div className="sync-status-left">
              <div className="pending-count">
                <span className="pending-icon">⬆️</span>
                <span>Package update available: v{updateInfo.latestVersion}</span>
              </div>
            </div>
            <div className="sync-status-right">
              <button 
                onClick={installUpdateNow}
                disabled={installingUpdate}
                className="sync-btn"
              >
                {installingUpdate ? 'Updating…' : 'Install Update'}
              </button>
              <button onClick={dismiss} className="btn-secondary" style={{ marginLeft: 8 }}>
                Later
              </button>
            </div>
          </div>
        )}
        <div className="header">
          <div className="app-logo-small">
            <button onClick={resetConnection} className="back-to-main-btn" title="Back to Main">
              ←
            </button>
            <img 
              src="/bunkerwatch-logo.svg" 
              alt="BunkerWatch" 
              className="logo-icon-animated"
              width="48" 
              height="48"
            />
            <h1>
              <span className="logo-bunker">Bunker</span>
              <span className="logo-watch">Watch</span>
            </h1>
          </div>
          <div className="connection-status">
            <span className="status-connected">
              ✅ {compartments.length} tanks • {isOnline ? "Online" : "Offline"}
            </span>
            {!lambdaUrl && (
              <span className="error-message" style={{ marginLeft: 8 }}>Lambda URL not configured</span>
            )}
            <button onClick={() => setShowAdmin(true)} className="btn-secondary" style={{ marginLeft: 8 }}>Admin</button>
          </div>
        </div>

        {/* Vessel Info Banner */}
        {currentVessel && (
          <VesselSelection 
            lambdaUrl={lambdaUrl} 
            onVesselSelected={handleVesselSelected}
            disableAutoSelect={false}
          />
        )}

        {/* Sync Status Bar */}
        <SyncStatus lambdaUrl={lambdaUrl} vesselId={currentVessel?.vessel_id} />

        {/* Tab Navigation */}
        <div className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === "sounding" ? "active" : ""}`}
            onClick={() => setActiveTab("sounding")}
          >
            <span className="tab-icon">📊</span>
            Tank Sounding
          </button>
          <button
            className={`tab-btn ${activeTab === "bunkering" ? "active" : ""}`}
            onClick={() => setActiveTab("bunkering")}
          >
            <span className="tab-icon">⛽</span>
            Bunkering Monitor
          </button>
        </div>

        {/* Sounding Tab Content */}
        {activeTab === "sounding" && (
          <div className="tab-content">
            <div className="global-inputs">
              <div className="form-group compact">
                <label htmlFor="reportDate">Date</label>
                <input
                  type="date"
                  id="reportDate"
                  value={reportDate}
                  onChange={(e) => setReportDate(e.target.value)}
                />
              </div>
              <div className="form-group compact">
                <label htmlFor="globalTrim">Trim (m)</label>
                <input
                  type="number"
                  id="globalTrim"
                  value={globalTrim}
                  onChange={(e) => setGlobalTrim(e.target.value)}
                  placeholder="0.5"
                  step="0.1"
                  min="-4.0"
                  max="4.0"
                />
              </div>
              <div className="form-group compact">
                <label htmlFor="globalHeel">Heel (°)</label>
                <input
                  type="number"
                  id="globalHeel"
                  value={globalHeel}
                  onChange={(e) => setGlobalHeel(e.target.value)}
                  placeholder="1.0"
                  step="0.1"
                  min="-3.0"
                  max="3.0"
                />
              </div>
            </div>
            <div className="content-grid">
              <div className="input-section">
                <h3 className="section-title">Tank Entries</h3>
                <table className="tank-table compact">
                  <thead>
                    <tr>
                      <th>Tank Name</th>
                      <th>Fuel Grade</th>
                      <th>Ullage (cm)</th>
                      <th>Density</th>
                      <th>Temp</th>
                      <th>Volume (m³)</th>
                      <th>mT</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tankEntries.map((entry, index) => (
                      <tr key={entry.id}>
                        <td>
                          <select
                            value={entry.compartment_id}
                            onChange={(e) =>
                              updateTankEntry(index, {
                                compartment_id: e.target.value,
                              })
                            }
                          >
                            <option value="">Select Tank</option>
                            {compartments.map((comp) => (
                              <option
                                key={comp.compartment_id}
                                value={comp.compartment_id}
                              >
                                {comp.compartment_name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            value={entry.fuel_grade}
                            onChange={(e) =>
                              updateTankEntry(index, {
                                fuel_grade: e.target.value,
                              })
                            }
                          >
                            <option value="">Select Grade</option>
                            {fuelGrades.map((grade) => (
                              <option key={grade} value={grade}>
                                {grade}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            value={entry.ullage}
                            onChange={(e) =>
                              updateTankEntry(index, { ullage: e.target.value })
                            }
                            placeholder="Ullage"
                            step="0.1"
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={entry.density}
                            onChange={(e) =>
                              updateTankEntry(index, {
                                density: e.target.value,
                              })
                            }
                            placeholder="Density"
                            step="0.001"
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={entry.temp}
                            onChange={(e) =>
                              updateTankEntry(index, { temp: e.target.value })
                            }
                            placeholder="Temp"
                            step="0.1"
                          />
                        </td>
                        <td className="volume-cell">
                          {formatVolumeDisplay(entry.result)}
                        </td>
                        <td>{calculateMT(entry.result, entry.density)}</td>
                        <td>
                          <button
                            onClick={() => fetchSoundingData(index)}
                            disabled={entry.loading || globalTrim === ""}
                            className="calculate-row-btn"
                          >
                            {entry.loading ? "..." : "Calc"}
                          </button>
                          {tankEntries.length > 1 && (
                            <button
                              onClick={() => removeTankRow(entry.id)}
                              className="remove-row-btn"
                            >
                              -
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="add-row-container">
                  <button onClick={addTankRow} className="add-row-btn">
                    + Add Tank Row
                  </button>
                </div>
                {tankEntries.some((entry) => entry.error) && (
                  <div className="error-message">
                    {tankEntries
                      .map((entry) => entry.error)
                      .filter(Boolean)
                      .join(", ")}
                  </div>
                )}
              </div>
            </div>
            {/* Total mT by Fuel Grade Summary */}
            {Object.keys(totalMtByFuelGrade).length > 0 && (
              <div className="summary-section">
                <h3>Total Mass by Fuel Grade</h3>
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th>Fuel Grade</th>
                      <th>Total mT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(totalMtByFuelGrade).map(
                      ([grade, total]) => (
                        <tr key={grade}>
                          <td>{grade}</td>
                          <td>{total.toFixed(2)} mT</td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>

                {/* Submit to Cloud Button */}
                <div className="submit-container">
                  <button
                    onClick={submitSoundingsToCloud}
                    disabled={
                      !isOnline ||
                      tankEntries.filter(
                        (e) =>
                          e.result &&
                          e.result.success &&
                          e.compartment_id &&
                          e.fuel_grade
                      ).length === 0
                    }
                    className="submit-cloud-btn"
                  >
                    {isOnline
                      ? "💾 Submit to Cloud"
                      : "📵 Offline - Cannot Submit"}
                  </button>
                  {submitStatus.message && (
                    <div className={`submit-status ${submitStatus.type}`}>
                      {submitStatus.message}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bunkering Tab Content */}
        {activeTab === "bunkering" && (
          <div className="tab-content">
            <div className="bunkering-header">
              <h3>Bunkering Operations Monitor</h3>
              <div className="bunker-controls">
                <label>Number of Bunkers:</label>
                <select
                  value={numBunkers}
                  onChange={(e) => updateNumBunkers(parseInt(e.target.value))}
                  className="bunker-select"
                >
                  <option value={1}>1 Bunker</option>
                  <option value={2}>2 Bunkers</option>
                </select>
              </div>
            </div>
            <div className={`bunkers-grid bunkers-${numBunkers}`}>
              {bunkeringData.slice(0, numBunkers).map((bunker, bunkerIndex) => (
                <div key={bunker.id} className="bunker-panel">
                  <div className="bunker-header">
                    <h4>{bunker.name}</h4>
                    <div className="bunker-status">
                      <span className="status-indicator active"></span>
                      Active
                    </div>
                  </div>
                  <div className="bunker-inputs">
                    <div className="input-row">
                      <div className="form-group">
                        <label>Density:</label>
                        <input
                          type="number"
                          value={bunker.density}
                          onChange={(e) =>
                            updateBunkerData(bunkerIndex, {
                              density: e.target.value,
                            })
                          }
                          placeholder="0.950"
                          step="0.001"
                        />
                      </div>
                      <div className="form-group">
                        <label>Temp (°C):</label>
                        <input
                          type="number"
                          value={bunker.temp}
                          onChange={(e) =>
                            updateBunkerData(bunkerIndex, {
                              temp: e.target.value,
                            })
                          }
                          placeholder="15.0"
                          step="0.1"
                        />
                      </div>
                      <div className="form-group">
                        <label>Total Qty (mT):</label>
                        <input
                          type="number"
                          value={bunker.totalQtyMT}
                          onChange={(e) =>
                            updateBunkerData(bunkerIndex, {
                              totalQtyMT: e.target.value,
                            })
                          }
                          placeholder="500"
                          step="1"
                        />
                      </div>
                    </div>
                    <div className="input-row">
                      <div className="form-group">
                        <label>Heel (°):</label>
                        <input
                          type="number"
                          value={bunker.heel}
                          onChange={(e) =>
                            updateBunkerData(bunkerIndex, {
                              heel: e.target.value,
                            })
                          }
                          placeholder="0.0"
                          step="0.1"
                        />
                      </div>
                      <div className="form-group">
                        <label>Trim (m):</label>
                        <input
                          type="number"
                          value={bunker.trim}
                          onChange={(e) =>
                            updateBunkerData(bunkerIndex, {
                              trim: e.target.value,
                            })
                          }
                          placeholder="0.5"
                          step="0.1"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="bunker-table-container">
                    <table className="bunker-table">
                      <thead>
                        <tr>
                          <th>Date/Time</th>
                          <th>Tank</th>
                          <th>Ullage (cm)</th>
                          <th>Volume (m³)</th>
                          <th>mT</th>
                          <th>% Full</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bunker.entries.map((entry, entryIndex) => {
                          const metrics =
                            entry.result && bunker.density
                              ? calculateBunkeringMetrics(bunker, entry)
                              : null;
                          return (
                            <tr key={entry.id}>
                              <td>
                                <input
                                  type="datetime-local"
                                  value={entry.timestamp}
                                  onChange={(e) =>
                                    updateBunkeringEntry(
                                      bunkerIndex,
                                      entryIndex,
                                      {
                                        timestamp: e.target.value,
                                      }
                                    )
                                  }
                                  className="timestamp-input"
                                />
                              </td>
                              <td>
                                <select
                                  value={entry.compartment_id}
                                  onChange={(e) =>
                                    updateBunkeringEntry(
                                      bunkerIndex,
                                      entryIndex,
                                      {
                                        compartment_id: e.target.value,
                                      }
                                    )
                                  }
                                >
                                  <option value="">Select Tank</option>
                                  {compartments.map((comp) => (
                                    <option
                                      key={comp.compartment_id}
                                      value={comp.compartment_id}
                                    >
                                      {comp.compartment_name}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  type="number"
                                  value={entry.ullage}
                                  onChange={(e) =>
                                    updateBunkeringEntry(
                                      bunkerIndex,
                                      entryIndex,
                                      {
                                        ullage: e.target.value,
                                      }
                                    )
                                  }
                                  placeholder="Ullage"
                                  step="0.1"
                                />
                              </td>
                              <td className="metric-cell">
                                {entry.result ? (
                                  <span className="volume-value">
                                    {(() => {
                                      const volume =
                                        entry.result.final_volume !== undefined
                                          ? entry.result.final_volume
                                          : entry.result.volume;
                                      return parseFloat(volume).toFixed(2);
                                    })()}
                                  </span>
                                ) : (
                                  <span className="no-data">-</span>
                                )}
                              </td>
                              <td className="metric-cell">
                                {metrics ? (
                                  <span className="mt-value">{metrics.mt}</span>
                                ) : (
                                  <span className="no-data">-</span>
                                )}
                              </td>
                              <td className="percent-cell">
                                {metrics ? (
                                  <div className="percent-display">
                                    <span>{metrics.percentFull}%</span>
                                    <div className="percent-bar">
                                      <div
                                        className="percent-fill"
                                        style={{
                                          width: `${Math.min(
                                            parseFloat(metrics.percentFull),
                                            100
                                          )}%`,
                                        }}
                                      ></div>
                                    </div>
                                  </div>
                                ) : (
                                  <span className="no-data">-</span>
                                )}
                              </td>
                              <td>
                                <button
                                  onClick={() =>
                                    fetchBunkeringData(bunkerIndex, entryIndex)
                                  }
                                  disabled={
                                    !isCalculationEnabled(bunker, entry)
                                  }
                                  className="calculate-row-btn"
                                >
                                  {entry.loading ? "..." : "Calc"}
                                </button>
                                {bunker.entries.length > 1 && (
                                  <button
                                    onClick={() =>
                                      removeBunkeringEntry(
                                        bunkerIndex,
                                        entry.id
                                      )
                                    }
                                    className="remove-row-btn"
                                  >
                                    -
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="add-row-container">
                      <button
                        onClick={() => addBunkeringEntry(bunkerIndex)}
                        className="add-row-btn"
                      >
                        + Add Reading
                      </button>
                    </div>
                    {bunker.entries.some((entry) => entry.error) && (
                      <div className="error-message">
                        {bunker.entries
                          .map((entry) => entry.error)
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      
      {/* Settings Modal */}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onLambdaUrlUpdated={handleLambdaUrlUpdated}
        />
      )}
      {showAdmin && (
        <AdminPanel
          lambdaUrl={lambdaUrl}
          onClose={() => setShowAdmin(false)}
        />
      )}
    </div>
  );
}

export default App;

