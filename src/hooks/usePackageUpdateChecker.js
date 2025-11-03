import { useEffect, useState, useRef } from 'react';
import { checkForDataUpdates } from '../db/dataPackageService';

export function usePackageUpdateChecker({ lambdaUrl, vessel, intervalMs = 5 * 60 * 1000 }) {
  const [updateInfo, setUpdateInfo] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    clearTimer();
    if (!lambdaUrl || !vessel) return;

    // immediate check once
    runCheck();
    // schedule
    timerRef.current = setInterval(runCheck, intervalMs);
    return clearTimer;
  }, [lambdaUrl, vessel?.vessel_id, vessel?.package_version, intervalMs]);

  async function runCheck() {
    try {
      const res = await checkForDataUpdates(lambdaUrl, vessel.vessel_id, vessel.package_version);
      if (res && res.update_available) {
        setUpdateInfo({ latestVersion: res.latest_version });
      } else {
        setUpdateInfo(null);
      }
    } catch {
      // ignore transient errors
    }
  }

  function clearTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  return { updateInfo, dismiss: () => setUpdateInfo(null), refreshNow: runCheck };
}


