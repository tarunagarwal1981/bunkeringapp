import React, { useEffect, useState } from 'react';
import { fetchVessels, adminBuildPackage } from '../db/dataPackageService';

function AdminPanel({ lambdaUrl, onClose }) {
  const [vessels, setVessels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [buildingId, setBuildingId] = useState(null);
  const [builtLinks, setBuiltLinks] = useState({}); // vesselId -> { url, version }
  const [adminCode, setAdminCode] = useState('');
  const [ttl, setTtl] = useState(86400);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const list = await fetchVessels(lambdaUrl);
        setVessels(list);
      } catch (e) {
        setError('Failed to load vessels: ' + e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [lambdaUrl]);

  const buildForVessel = async (vesselId) => {
    try {
      if (!adminCode) {
        setError('Enter admin code');
        return;
      }
      setBuildingId(vesselId);
      const res = await adminBuildPackage(lambdaUrl, vesselId, adminCode, ttl);
      const appOrigin = window.location.origin;
      const deepLink = `${appOrigin}/?lambda=${encodeURIComponent(lambdaUrl)}&vesselId=${encodeURIComponent(vesselId)}&install=1`;
      setBuiltLinks((prev) => ({ ...prev, [vesselId]: { url: res.manifestUrl, version: res.version, deepLink } }));
    } catch (e) {
      setError('Build failed: ' + e.message);
    } finally {
      setBuildingId(null);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>🛠️ Admin - Per-vessel Packages</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        <div className="settings-content">
          {error && <div className="error-message">{error}</div>}
          <div className="settings-section">
            <h3>Admin Access</h3>
            <div className="form-group">
              <label>Admin Code:</label>
              <input type="password" value={adminCode} onChange={(e) => setAdminCode(e.target.value)} placeholder="Enter admin code" />
            </div>
            <div className="form-group">
              <label>Link TTL (seconds):</label>
              <input type="number" value={ttl} onChange={(e) => setTtl(parseInt(e.target.value || '0', 10))} min={60} max={2592000} />
            </div>
          </div>
          {loading ? (
            <div>Loading vessels…</div>
          ) : (
            <div className="settings-section">
              <h3>Vessels</h3>
              <table className="summary-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>IMO</th>
                    <th>Compartments</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {vessels.map(v => (
                    <tr key={v.vessel_id}>
                      <td>{v.vessel_name}</td>
                      <td>{v.imo_number || '-'}</td>
                      <td>{v.compartment_count || '-'}</td>
                      <td>
                        <button 
                          onClick={() => buildForVessel(v.vessel_id)}
                          disabled={buildingId === v.vessel_id}
                          className="btn-primary"
                        >
                          {buildingId === v.vessel_id ? 'Building…' : 'Build Package'}
                        </button>
                        {builtLinks[v.vessel_id]?.url && (
                          <span style={{ marginLeft: 10 }}>
                            <a href={builtLinks[v.vessel_id].url} target="_blank" rel="noreferrer">Open</a>
                            <button 
                              className="btn-secondary"
                              style={{ marginLeft: 8 }}
                              onClick={() => copy(builtLinks[v.vessel_id].url)}
                            >Copy Link</button>
                            {builtLinks[v.vessel_id].deepLink && (
                              <>
                                <span style={{ margin: '0 6px' }}>|</span>
                                <a href={builtLinks[v.vessel_id].deepLink} target="_blank" rel="noreferrer">Open in App</a>
                                <button 
                                  className="btn-secondary"
                                  style={{ marginLeft: 8 }}
                                  onClick={() => copy(builtLinks[v.vessel_id].deepLink)}
                                >Copy App Link</button>
                              </>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminPanel;


