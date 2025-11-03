const { Pool } = require('pg');
const crypto = require('crypto');
const zlib = require('zlib');
const util = require('util');

const gzip = util.promisify(zlib.gzip);

// Database configuration - use environment variables
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10,
});
// ===================== Signing helpers =====================
const SIGNING_SECRET = process.env.SIGNING_SECRET || '';
const REQUIRE_SIGNED = (process.env.REQUIRE_SIGNED || 'false').toLowerCase() === 'true';
const ADMIN_CODE = process.env.ADMIN_CODE || '';

function hmacSha256Hex(message, secret) {
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function createSignedToken(vesselId, expiresEpochSeconds) {
    if (!SIGNING_SECRET) return null;
    const payload = `${vesselId}:${expiresEpochSeconds}`;
    return hmacSha256Hex(payload, SIGNING_SECRET);
}

function validateSignedRequest(vesselId, query) {
    if (!REQUIRE_SIGNED) return { valid: true };
    if (!SIGNING_SECRET) return { valid: false, reason: 'Signing not configured' };
    const token = query?.token;
    const expires = parseInt(query?.expires || '0', 10);
    if (!token || !expires) return { valid: false, reason: 'Missing token or expires' };
    const now = Math.floor(Date.now() / 1000);
    if (expires < now) return { valid: false, reason: 'Token expired' };
    const expected = createSignedToken(vesselId, expires);
    if (expected !== token) return { valid: false, reason: 'Invalid token' };
    return { valid: true };
}


// Test database connection
const testConnection = async () => {
    try {
        const client = await pool.connect();
        console.log('Database connection successful');
        client.release();
        return true;
    } catch (error) {
        console.error('Database connection failed:', error.message);
        return false;
    }
};

// =====================================================
// NEW: BunkerWatch Vessel Management Endpoints
// =====================================================

/**
 * GET /vessels
 * Get list of all active vessels
 */
const getVessels = async () => {
    // Only return vessels that have compartments AND calibration data
    const query = `
        SELECT DISTINCT 
            v.vessel_id, 
            v.vessel_name, 
            v.imo_number,
            COUNT(DISTINCT c.compartment_id) as compartment_count
        FROM vessels v
        INNER JOIN compartments c ON v.vessel_id = c.vessel_id
        INNER JOIN main_sounding_trim_data mstd ON c.compartment_id = mstd.compartment_id
        WHERE c.vessel_id IS NOT NULL 
          AND mstd.compartment_id IS NOT NULL
        GROUP BY v.vessel_id, v.vessel_name, v.imo_number
        HAVING COUNT(DISTINCT c.compartment_id) > 0
        ORDER BY v.vessel_name
    `;
    
    const result = await pool.query(query);
    
    return {
        success: true,
        data: result.rows,
        count: result.rows.length
    };
};

/**
 * GET /vessel/{vessel_id}/info
 * Get detailed vessel information
 */
const getVesselInfo = async (vesselId) => {
    const query = `
        SELECT 
            v.vessel_id,
            v.vessel_name,
            v.imo_number,
            COUNT(DISTINCT c.compartment_id) as total_compartments
        FROM vessels v
        LEFT JOIN compartments c ON v.vessel_id = c.vessel_id
        WHERE v.vessel_id = $1
        GROUP BY v.vessel_id, v.vessel_name, v.imo_number
    `;
    
    const result = await pool.query(query, [vesselId]);
    
    if (result.rows.length === 0) {
        throw new Error('Vessel not found');
    }
    
    return {
        success: true,
        data: result.rows[0]
    };
};

/**
 * GET /vessel/{vessel_id}/data-package
 * Generate complete data package for offline use
 */
const generateVesselDataPackage = async (vesselId) => {
    try {
        console.log(`📦 [DATA-PACKAGE] Generating package for vessel_id: ${vesselId}`);
        
        // 1. Get vessel info
        const vesselQuery = `
            SELECT vessel_id, vessel_name, imo_number
            FROM vessels
            WHERE vessel_id = $1
        `;
        const vesselResult = await pool.query(vesselQuery, [vesselId]);
        
        if (vesselResult.rows.length === 0) {
            throw new Error('Vessel not found');
        }
        
        const vessel = vesselResult.rows[0];
        console.log(`📦 [DATA-PACKAGE] Found vessel: ${vessel.vessel_name} (ID: ${vessel.vessel_id})`);
        
        // 2. Get compartments for this vessel - ONLY compartments with calibration data
        const compartmentsQuery = `
            SELECT DISTINCT c.compartment_id, c.vessel_id, c.compartment_name, 
                   c.total_net_volume_m3 as capacity
            FROM compartments c
            INNER JOIN main_sounding_trim_data mstd 
                ON c.compartment_id = mstd.compartment_id 
                AND c.vessel_id = mstd.vessel_id
            WHERE c.vessel_id = $1
            ORDER BY c.compartment_name
        `;
        const compartments = await pool.query(compartmentsQuery, [vesselId]);
        console.log(`📦 [DATA-PACKAGE] Found ${compartments.rows.length} compartments WITH calibration data for vessel ${vessel.vessel_name}`);
        
        if (compartments.rows.length === 0) {
            throw new Error('No compartments with calibration data found for this vessel');
        }
        
        // Log first few compartments to verify they belong to correct vessel
        if (compartments.rows.length > 0) {
            console.log(`📦 [DATA-PACKAGE] Sample compartments:`, {
                count: compartments.rows.length,
                first: compartments.rows[0],
                last: compartments.rows[compartments.rows.length - 1]
            });
        }
        
        // 3. Get calibration data for each compartment
        const calibrationData = {};
        let totalMainRows = 0;
        let totalHeelRows = 0;
        
        for (const comp of compartments.rows) {
            const compartmentId = comp.compartment_id;
            
            // Get main sounding data
            const mainSoundingQuery = `
                SELECT 
                    ullage, sound, lcg, tcg, vcg, iy,
                    trim_minus_4_0, trim_minus_3_0, trim_minus_2_0, 
                    trim_minus_1_5, trim_minus_1_0, trim_minus_0_5,
                    trim_0_0,
                    trim_plus_0_5, trim_plus_1_0, trim_plus_1_5,
                    trim_plus_2_0, trim_plus_3_0, trim_plus_4_0
                FROM main_sounding_trim_data
                WHERE compartment_id = $1 AND vessel_id = $2
                ORDER BY ullage
            `;
            const mainSounding = await pool.query(mainSoundingQuery, [compartmentId, vesselId]);
            totalMainRows += mainSounding.rows.length;
            
            // Get heel correction data
            const heelCorrectionQuery = `
                SELECT 
                    ullage,
                    heel_minus_3_0, heel_minus_2_0, heel_minus_1_5,
                    heel_minus_1_0, heel_minus_0_5, heel_0_0,
                    heel_plus_0_5, heel_plus_1_0, heel_plus_1_5,
                    heel_plus_2_0, heel_plus_3_0
                FROM heel_correction_data
                WHERE compartment_id = $1 AND vessel_id = $2
                ORDER BY ullage
            `;
            const heelCorrection = await pool.query(heelCorrectionQuery, [compartmentId, vesselId]);
            totalHeelRows += heelCorrection.rows.length;
            
            calibrationData[compartmentId] = {
                compartment_info: comp,
                main_sounding: mainSounding.rows,
                heel_correction: heelCorrection.rows
            };
        }
        
        // 4. Build complete package
        const dataPackage = {
            vessel_id: vessel.vessel_id,
            vessel_name: vessel.vessel_name,
            imo_number: vessel.imo_number,
            package_version: 1,
            generated_at: new Date().toISOString(),
            compartments: compartments.rows,
            calibration_data: calibrationData,
            metadata: {
                total_compartments: compartments.rows.length,
                total_calibration_rows: totalMainRows + totalHeelRows,
                main_sounding_rows: totalMainRows,
                heel_correction_rows: totalHeelRows
            }
        };
        
        // 5. Calculate package size
        const packageJson = JSON.stringify(dataPackage);
        const packageSizeKB = Math.round(Buffer.byteLength(packageJson, 'utf8') / 1024);
        
        console.log(`Generated data package for ${vessel.vessel_name}: ${packageSizeKB}KB`);
        
        // 6. Optional: Log package generation (you can uncomment if you want to track)
        // const logQuery = `
        //     INSERT INTO vessel_data_packages 
        //     (vessel_id, package_version, package_size_kb, total_compartments, total_calibration_rows)
        //     VALUES ($1, 1, $2, $3, $4)
        //     ON CONFLICT (vessel_id, package_version) 
        //     DO UPDATE SET generated_at = CURRENT_TIMESTAMP
        // `;
        // await pool.query(logQuery, [vesselId, packageSizeKB, compartments.rows.length, totalMainRows + totalHeelRows]);
        
        return {
            success: true,
            data: dataPackage
        };
        
    } catch (error) {
        console.error('Error generating vessel data package:', error);
        throw error;
    }
};

/**
 * GET /vessel/{vessel_id}/compartments
 * Get compartments for specific vessel (alternative to /compartments with vessel filter)
 * ONLY compartments with calibration data
 */
const getVesselCompartments = async (vesselId) => {
    const query = `
        SELECT DISTINCT c.compartment_id, c.vessel_id, c.compartment_name, 
               c.total_net_volume_m3 as capacity
        FROM compartments c
        INNER JOIN main_sounding_trim_data mstd 
            ON c.compartment_id = mstd.compartment_id 
            AND c.vessel_id = mstd.vessel_id
        WHERE c.vessel_id = $1
        ORDER BY c.compartment_name
    `;
    const result = await pool.query(query, [vesselId]);
    
    return {
        success: true,
        data: result.rows,
        count: result.rows.length,
        vessel_id: vesselId
    };
};

/**
 * POST /vessel/{vessel_id}/sync-soundings
 * Sync sounding logs from vessel (offline data) with summary
 */
const syncSoundings = async (vesselId, payload) => {
    const client = await pool.connect();
    
    try {
        console.log(`[SYNC] Starting sync for vessel_id: ${vesselId} (type: ${typeof vesselId})`);
        console.log(`[SYNC] Soundings count: ${payload.soundings?.length || 0}`);
        console.log(`[SYNC] Summary present: ${!!payload.summary}`);
        
        // Log first sounding for debugging
        if (payload.soundings && payload.soundings.length > 0) {
            console.log(`[SYNC] Sample sounding:`, JSON.stringify(payload.soundings[0], null, 2));
        }
        
        await client.query('BEGIN');
        
        const soundings = payload.soundings || [];
        const summary = payload.summary || null;
        
        const insertedIds = [];
        const skippedDuplicates = [];
        let summaryId = null;
        
        // 1. Insert summary data first (if provided)
        if (summary) {
            const summaryQuery = `
                INSERT INTO sounding_reports (
                    vessel_id, session_id, recorded_at, report_date,
                    total_tanks, grand_total_mt, trim, heel,
                    summary_data, sync_status, synced_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, 'synced', CURRENT_TIMESTAMP
                )
                RETURNING report_id
            `;
            
            const summaryResult = await client.query(summaryQuery, [
                vesselId,
                summary.session_id,
                summary.recorded_at,
                summary.report_date,
                summary.total_tanks,
                summary.grand_total_mt,
                summary.trim,
                summary.heel || null,
                JSON.stringify(summary.total_mass_by_fuel_grade) // Store as JSONB
            ]);
            
            summaryId = summaryResult.rows[0].report_id;
            console.log(`✓ Summary saved with report_id: ${summaryId}`);
        }
        
        // 2. Insert individual soundings
        for (const sounding of soundings) {
            // Check for duplicate using client_id
            const checkQuery = `
                SELECT log_id FROM sounding_logs WHERE client_id = $1
            `;
            const existing = await client.query(checkQuery, [sounding.client_id]);
            
            if (existing.rows.length > 0) {
                skippedDuplicates.push(sounding.client_id);
                continue;
            }
            
            // Insert new sounding with session_id
            const insertQuery = `
                INSERT INTO sounding_logs (
                    vessel_id, compartment_id, session_id, recorded_at, report_date,
                    ullage, trim, heel, fuel_grade, density, temperature,
                    base_volume, heel_correction, final_volume, calculated_mt,
                    user_name, device_info, app_version, client_id,
                    sync_status, synced_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                    $12, $13, $14, $15, $16, $17, $18, $19, 'synced', CURRENT_TIMESTAMP
                )
                RETURNING log_id
            `;
            
            const result = await client.query(insertQuery, [
                vesselId,
                sounding.compartment_id,
                sounding.session_id || null, // Group soundings by session
                sounding.recorded_at,
                sounding.report_date,
                sounding.ullage,
                sounding.trim,
                sounding.heel || null,
                sounding.fuel_grade || null,
                sounding.density || null,
                sounding.temperature || null,
                sounding.base_volume,
                sounding.heel_correction || 0,
                sounding.final_volume,
                sounding.calculated_mt || null,
                sounding.user_name || null,
                sounding.device_info || null,
                sounding.app_version || null,
                sounding.client_id
            ]);
            
            insertedIds.push(result.rows[0].log_id);
        }
        
        await client.query('COMMIT');
        
        return {
            success: true,
            inserted: insertedIds.length,
            skipped: skippedDuplicates.length,
            inserted_ids: insertedIds,
            summary_id: summaryId,
            session_id: summary?.session_id || null
        };
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[SYNC] Error syncing soundings:', error.message);
        console.error('[SYNC] Error stack:', error.stack);
        console.error('[SYNC] Vessel ID that failed:', vesselId);
        throw error;
    } finally {
        client.release();
    }
};

/**
 * POST /vessel/{vessel_id}/sync-bunkering
 * Sync bunkering operations from vessel (offline data)
 */
const syncBunkering = async (vesselId, bunkeringOps) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const insertedOps = [];
        
        for (const bunker of bunkeringOps) {
            // Check for duplicate
            const checkQuery = `
                SELECT bunkering_id FROM bunkering_operations WHERE client_id = $1
            `;
            const existing = await client.query(checkQuery, [bunker.client_id]);
            
            if (existing.rows.length > 0) {
                continue;
            }
            
            // Insert bunkering operation
            const opQuery = `
                INSERT INTO bunkering_operations (
                    vessel_id, bunker_name, fuel_grade, density, temperature,
                    total_quantity_mt, trim, heel, started_at, completed_at,
                    supplier_name, port_name, user_name, client_id,
                    sync_status, synced_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, 'synced', CURRENT_TIMESTAMP
                )
                RETURNING bunkering_id
            `;
            
            const opResult = await client.query(opQuery, [
                vesselId, bunker.bunker_name, bunker.fuel_grade,
                bunker.density, bunker.temperature, bunker.total_quantity_mt,
                bunker.trim, bunker.heel, bunker.started_at, bunker.completed_at,
                bunker.supplier_name, bunker.port_name, bunker.user_name,
                bunker.client_id
            ]);
            
            const bunkeringId = opResult.rows[0].bunkering_id;
            
            // Insert readings
            for (const reading of bunker.readings || []) {
                const readingQuery = `
                    INSERT INTO bunkering_readings (
                        bunkering_id, compartment_id, timestamp, ullage,
                        calculated_volume, calculated_mt, percent_full, client_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `;
                
                await client.query(readingQuery, [
                    bunkeringId, reading.compartment_id, reading.timestamp,
                    reading.ullage, reading.calculated_volume, reading.calculated_mt,
                    reading.percent_full, reading.client_id
                ]);
            }
            
            insertedOps.push(bunkeringId);
        }
        
        await client.query('COMMIT');
        
        return {
            success: true,
            inserted: insertedOps.length,
            inserted_ids: insertedOps
        };
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error syncing bunkering:', error);
        throw error;
    } finally {
        client.release();
    }
};

// =====================================================
// EXISTING: Interpolation and Sounding Functions
// (Keep all your existing functions here - they're perfect!)
// =====================================================

// [... all your existing getTrimColumn, getHeelColumn, getTrimBounds, 
//  getHeelBounds, linearInterpolate, getUllageBounds, etc. functions ...]

// I'll include them for completeness:

const getTrimColumn = (trimValue) => {
    const trimFloat = parseFloat(trimValue);
    if (trimFloat >= 4.0) return 'trim_plus_4_0';
    if (trimFloat >= 3.0) return 'trim_plus_3_0';
    if (trimFloat >= 2.0) return 'trim_plus_2_0';
    if (trimFloat >= 1.5) return 'trim_plus_1_5';
    if (trimFloat >= 1.0) return 'trim_plus_1_0';
    if (trimFloat >= 0.5) return 'trim_plus_0_5';
    if (trimFloat >= 0.0) return 'trim_0_0';
    if (trimFloat >= -0.5) return 'trim_minus_0_5';
    if (trimFloat >= -1.0) return 'trim_minus_1_0';
    if (trimFloat >= -1.5) return 'trim_minus_1_5';
    if (trimFloat >= -2.0) return 'trim_minus_2_0';
    if (trimFloat >= -3.0) return 'trim_minus_3_0';
    return 'trim_minus_4_0';
};

const getHeelColumn = (heelValue) => {
    const heelFloat = parseFloat(heelValue);
    if (heelFloat >= 3.0) return 'heel_plus_3_0';
    if (heelFloat >= 2.0) return 'heel_plus_2_0';
    if (heelFloat >= 1.5) return 'heel_plus_1_5';
    if (heelFloat >= 1.0) return 'heel_plus_1_0';
    if (heelFloat >= 0.5) return 'heel_plus_0_5';
    if (heelFloat >= 0.0) return 'heel_0_0';
    if (heelFloat >= -0.5) return 'heel_minus_0_5';
    if (heelFloat >= -1.0) return 'heel_minus_1_0';
    if (heelFloat >= -1.5) return 'heel_minus_1_5';
    if (heelFloat >= -2.0) return 'heel_minus_2_0';
    return 'heel_minus_3_0';
};

const getTrimBounds = (targetTrim) => {
    const trimRanges = [
        { value: -4.0, column: 'trim_minus_4_0' },
        { value: -3.0, column: 'trim_minus_3_0' },
        { value: -2.0, column: 'trim_minus_2_0' },
        { value: -1.5, column: 'trim_minus_1_5' },
        { value: -1.0, column: 'trim_minus_1_0' },
        { value: -0.5, column: 'trim_minus_0_5' },
        { value: 0.0, column: 'trim_0_0' },
        { value: 0.5, column: 'trim_plus_0_5' },
        { value: 1.0, column: 'trim_plus_1_0' },
        { value: 1.5, column: 'trim_plus_1_5' },
        { value: 2.0, column: 'trim_plus_2_0' },
        { value: 3.0, column: 'trim_plus_3_0' },
        { value: 4.0, column: 'trim_plus_4_0' }
    ];

    const target = parseFloat(targetTrim);
    const exactMatch = trimRanges.find(t => t.value === target);
    if (exactMatch) {
        return { exact: true, column: exactMatch.column };
    }

    let lowerTrim = null, upperTrim = null;
    for (let i = 0; i < trimRanges.length - 1; i++) {
        if (target > trimRanges[i].value && target < trimRanges[i + 1].value) {
            lowerTrim = trimRanges[i];
            upperTrim = trimRanges[i + 1];
            break;
        }
    }

    if (!lowerTrim || !upperTrim) {
        if (target < trimRanges[0].value) {
            return { outOfRange: true, message: `Trim ${target} is below minimum supported trim ${trimRanges[0].value}` };
        } else {
            return { outOfRange: true, message: `Trim ${target} is above maximum supported trim ${trimRanges[trimRanges.length - 1].value}` };
        }
    }

    return { exact: false, lowerTrim, upperTrim };
};

const getHeelBounds = (targetHeel) => {
    const heelRanges = [
        { value: -3.0, column: 'heel_minus_3_0' },
        { value: -2.0, column: 'heel_minus_2_0' },
        { value: -1.5, column: 'heel_minus_1_5' },
        { value: -1.0, column: 'heel_minus_1_0' },
        { value: -0.5, column: 'heel_minus_0_5' },
        { value: 0.0, column: 'heel_0_0' },
        { value: 0.5, column: 'heel_plus_0_5' },
        { value: 1.0, column: 'heel_plus_1_0' },
        { value: 1.5, column: 'heel_plus_1_5' },
        { value: 2.0, column: 'heel_plus_2_0' },
        { value: 3.0, column: 'heel_plus_3_0' }
    ];

    const target = parseFloat(targetHeel);
    const exactMatch = heelRanges.find(h => h.value === target);
    if (exactMatch) {
        return { exact: true, column: exactMatch.column };
    }

    let lowerHeel = null, upperHeel = null;
    for (let i = 0; i < heelRanges.length - 1; i++) {
        if (target > heelRanges[i].value && target < heelRanges[i + 1].value) {
            lowerHeel = heelRanges[i];
            upperHeel = heelRanges[i + 1];
            break;
        }
    }

    if (!lowerHeel || !upperHeel) {
        if (target < heelRanges[0].value) {
            return { outOfRange: true, message: `Heel ${target} is below minimum supported heel ${heelRanges[0].value}` };
        } else {
            return { outOfRange: true, message: `Heel ${target} is above maximum supported heel ${heelRanges[heelRanges.length - 1].value}` };
        }
    }

    return { exact: false, lowerHeel, upperHeel };
};

const linearInterpolate = (x1, y1, x2, y2, x) => {
    const nx1 = parseFloat(x1);
    const ny1 = parseFloat(y1);
    const nx2 = parseFloat(x2);
    const ny2 = parseFloat(y2);
    const nx = parseFloat(x);
    
    if (nx1 === nx2) return ny1;
    return ny1 + (ny2 - ny1) * ((nx - nx1) / (nx2 - nx1));
};

const getUllageBounds = async (compartmentId, targetUllage) => {
    const query = `
        SELECT DISTINCT ullage 
        FROM main_sounding_trim_data 
        WHERE compartment_id = $1 
        ORDER BY ullage
    `;
    
    const result = await pool.query(query, [compartmentId]);
    const ullages = result.rows.map(row => parseFloat(row.ullage));
    
    if (ullages.length === 0) {
        return { outOfRange: true, message: 'No ullage data found for this compartment' };
    }

    const target = parseFloat(targetUllage);
    
    if (ullages.includes(target)) {
        return { exact: true, ullage: target };
    }

    let lowerUllage = null, upperUllage = null;
    
    for (let i = 0; i < ullages.length - 1; i++) {
        if (target > ullages[i] && target < ullages[i + 1]) {
            lowerUllage = ullages[i];
            upperUllage = ullages[i + 1];
            break;
        }
    }

    if (lowerUllage === null || upperUllage === null) {
        if (target < ullages[0]) {
            return { outOfRange: true, message: `Ullage ${target} is below minimum ullage ${ullages[0]}` };
        } else {
            return { outOfRange: true, message: `Ullage ${target} is above maximum ullage ${ullages[ullages.length - 1]}` };
        }
    }

    return { exact: false, lowerUllage, upperUllage };
};

const getHeelUllageBounds = async (compartmentId, targetUllage) => {
    const query = `
        SELECT DISTINCT ullage 
        FROM heel_correction_data 
        WHERE compartment_id = $1 
        ORDER BY ullage
    `;
    
    const result = await pool.query(query, [compartmentId]);
    const ullages = result.rows.map(row => parseFloat(row.ullage));
    
    if (ullages.length === 0) {
        return { outOfRange: true, message: 'No heel ullage data found for this compartment' };
    }

    const target = parseFloat(targetUllage);
    
    if (ullages.includes(target)) {
        return { exact: true, ullage: target };
    }

    let lowerUllage = null, upperUllage = null;
    
    for (let i = 0; i < ullages.length - 1; i++) {
        if (target > ullages[i] && target < ullages[i + 1]) {
            lowerUllage = ullages[i];
            upperUllage = ullages[i + 1];
            break;
        }
    }

    if (lowerUllage === null || upperUllage === null) {
        if (target < ullages[0]) {
            return { outOfRange: true, message: `Ullage ${target} is below minimum heel correction ullage ${ullages[0]}` };
        } else {
            return { outOfRange: true, message: `Ullage ${target} is above maximum heel correction ullage ${ullages[ullages.length - 1]}` };
        }
    }

    return { exact: false, lowerUllage, upperUllage };
};

const getHeelCorrectionWithInterpolation = async (compartmentId, targetUllage, targetHeel) => {
    const heelBounds = getHeelBounds(targetHeel);
    
    if (heelBounds.outOfRange) {
        throw new Error(heelBounds.message);
    }

    if (heelBounds.exact) {
        return await getHeelCorrectionWithUllageInterpolation(compartmentId, targetUllage, heelBounds.column, targetHeel);
    }

    const { lowerHeel, upperHeel } = heelBounds;
    
    const ullageBounds = await getHeelUllageBounds(compartmentId, targetUllage);
    if (ullageBounds.outOfRange) {
        throw new Error(ullageBounds.message);
    }

    if (ullageBounds.exact) {
        const exactUllage = ullageBounds.ullage;
        const query = `
            SELECT ullage, ${lowerHeel.column}, ${upperHeel.column}
            FROM heel_correction_data 
            WHERE compartment_id = $1 AND ullage = $2
            LIMIT 1
        `;
        
        const result = await pool.query(query, [compartmentId, exactUllage]);
        if (result.rows.length === 0) {
            throw new Error('No heel correction data found for exact ullage match');
        }

        const row = result.rows[0];
        const interpolatedCorrection = linearInterpolate(
            lowerHeel.value, parseFloat(row[lowerHeel.column]) || 0,
            upperHeel.value, parseFloat(row[upperHeel.column]) || 0,
            parseFloat(targetHeel)
        );

        return {
            heel_correction: interpolatedCorrection,
            interpolation_used: 'heel_only'
        };
    }

    const { lowerUllage, upperUllage } = ullageBounds;
    
    const query = `
        SELECT ullage, ${lowerHeel.column}, ${upperHeel.column}
        FROM heel_correction_data 
        WHERE compartment_id = $1 AND ullage IN ($2, $3)
        ORDER BY ullage
    `;
    
    const result = await pool.query(query, [compartmentId, lowerUllage, upperUllage]);
    if (result.rows.length !== 2) {
        throw new Error('Insufficient heel correction data for bilinear interpolation');
    }

    const lowerUllageRow = result.rows[0];
    const upperUllageRow = result.rows[1];

    const correctionAtLowerUllage = linearInterpolate(
        lowerHeel.value, parseFloat(lowerUllageRow[lowerHeel.column]) || 0,
        upperHeel.value, parseFloat(lowerUllageRow[upperHeel.column]) || 0,
        parseFloat(targetHeel)
    );

    const correctionAtUpperUllage = linearInterpolate(
        lowerHeel.value, parseFloat(upperUllageRow[lowerHeel.column]) || 0,
        upperHeel.value, parseFloat(upperUllageRow[upperHeel.column]) || 0,
        parseFloat(targetHeel)
    );

    const finalCorrection = linearInterpolate(
        lowerUllage, correctionAtLowerUllage,
        upperUllage, correctionAtUpperUllage,
        parseFloat(targetUllage)
    );

    return {
        heel_correction: finalCorrection,
        interpolation_used: 'bilinear',
        interpolation_bounds: {
            ullage: { lower: lowerUllage, upper: upperUllage },
            heel: { lower: lowerHeel.value, upper: upperHeel.value }
        }
    };
};

const getHeelCorrectionWithUllageInterpolation = async (compartmentId, targetUllage, heelColumn, targetHeel) => {
    const ullageBounds = await getHeelUllageBounds(compartmentId, targetUllage);
    
    if (ullageBounds.outOfRange) {
        throw new Error(ullageBounds.message);
    }

    if (ullageBounds.exact) {
        const query = `
            SELECT ${heelColumn} as heel_correction
            FROM heel_correction_data 
            WHERE compartment_id = $1 AND ullage = $2
            LIMIT 1
        `;
        
        const result = await pool.query(query, [compartmentId, ullageBounds.ullage]);
        if (result.rows.length === 0) {
            throw new Error('No heel correction data found for exact match');
        }

        const row = result.rows[0];
        return {
            heel_correction: parseFloat(row.heel_correction) || 0,
            interpolation_used: 'none'
        };
    }

    const { lowerUllage, upperUllage } = ullageBounds;
    const query = `
        SELECT ${heelColumn} as heel_correction, ullage
        FROM heel_correction_data 
        WHERE compartment_id = $1 AND ullage IN ($2, $3)
        ORDER BY ullage
    `;
    
    const result = await pool.query(query, [compartmentId, lowerUllage, upperUllage]);
    if (result.rows.length !== 2) {
        throw new Error('Insufficient heel correction data for ullage interpolation');
    }

    const lowerRow = result.rows[0];
    const upperRow = result.rows[1];

    const interpolatedCorrection = linearInterpolate(
        lowerUllage, parseFloat(lowerRow.heel_correction) || 0, 
        upperUllage, parseFloat(upperRow.heel_correction) || 0, 
        parseFloat(targetUllage)
    );

    return {
        heel_correction: interpolatedCorrection,
        interpolation_used: 'ullage_only',
        interpolation_bounds: {
            ullage: { lower: lowerUllage, upper: upperUllage }
        }
    };
};

const getSoundingWithUllageInterpolation = async (compartmentId, targetUllage, trimColumn, targetTrim) => {
    const ullageBounds = await getUllageBounds(compartmentId, targetUllage);
    
    if (ullageBounds.outOfRange) {
        throw new Error(ullageBounds.message);
    }

    if (ullageBounds.exact) {
        const query = `
            SELECT ${trimColumn} as volume, sound, ullage, lcg, tcg, vcg, iy
            FROM main_sounding_trim_data 
            WHERE compartment_id = $1 AND ullage = $2
            LIMIT 1
        `;
        
        const result = await pool.query(query, [compartmentId, ullageBounds.ullage]);
        if (result.rows.length === 0) {
            throw new Error('No data found for exact match');
        }

        const row = result.rows[0];
        return {
            volume: parseFloat(row.volume) || 0,
            sound: parseFloat(row.sound) || null,
            ullage: parseFloat(row.ullage),
            lcg: parseFloat(row.lcg) || 0,
            tcg: parseFloat(row.tcg) || 0,
            vcg: parseFloat(row.vcg) || 0,
            iy: parseFloat(row.iy) || 0,
            interpolation_used: 'none'
        };
    }

    const { lowerUllage, upperUllage } = ullageBounds;
    const query = `
        SELECT ${trimColumn} as volume, sound, ullage, lcg, tcg, vcg, iy
        FROM main_sounding_trim_data 
        WHERE compartment_id = $1 AND ullage IN ($2, $3)
        ORDER BY ullage
    `;
    
    const result = await pool.query(query, [compartmentId, lowerUllage, upperUllage]);
    if (result.rows.length !== 2) {
        throw new Error('Insufficient data for ullage interpolation');
    }

    const lowerRow = result.rows[0];
    const upperRow = result.rows[1];

    const interpolateValue = (prop) => {
        return linearInterpolate(
            lowerUllage, parseFloat(lowerRow[prop]) || 0, 
            upperUllage, parseFloat(upperRow[prop]) || 0, 
            parseFloat(targetUllage)
        );
    };

    return {
        volume: interpolateValue('volume'),
        sound: Math.round(interpolateValue('sound')) || null,
        ullage: parseFloat(targetUllage),
        lcg: interpolateValue('lcg'),
        tcg: interpolateValue('tcg'),
        vcg: interpolateValue('vcg'),
        iy: interpolateValue('iy'),
        interpolation_used: 'ullage_only',
        interpolation_bounds: {
            ullage: { lower: lowerUllage, upper: upperUllage }
        }
    };
};

const getSoundingDataWithInterpolation = async (compartmentId, targetUllage, targetTrim) => {
    const trimBounds = getTrimBounds(targetTrim);
    
    if (trimBounds.outOfRange) {
        throw new Error(trimBounds.message);
    }

    if (trimBounds.exact) {
        return await getSoundingWithUllageInterpolation(compartmentId, targetUllage, trimBounds.column, targetTrim);
    }

    const { lowerTrim, upperTrim } = trimBounds;
    
    const ullageBounds = await getUllageBounds(compartmentId, targetUllage);
    if (ullageBounds.outOfRange) {
        throw new Error(ullageBounds.message);
    }

    if (ullageBounds.exact) {
        const exactUllage = ullageBounds.ullage;
        const query = `
            SELECT ullage, ${lowerTrim.column}, ${upperTrim.column}, lcg, tcg, vcg, iy, sound
            FROM main_sounding_trim_data 
            WHERE compartment_id = $1 AND ullage = $2
            LIMIT 1
        `;
        
        const result = await pool.query(query, [compartmentId, exactUllage]);
        if (result.rows.length === 0) {
            throw new Error('No data found for exact ullage match');
        }

        const row = result.rows[0];
        const interpolatedVolume = linearInterpolate(
            lowerTrim.value, parseFloat(row[lowerTrim.column]) || 0,
            upperTrim.value, parseFloat(row[upperTrim.column]) || 0,
            parseFloat(targetTrim)
        );

        return {
            volume: interpolatedVolume,
            sound: parseFloat(row.sound) || null,
            ullage: parseFloat(targetUllage),
            lcg: parseFloat(row.lcg) || 0,
            tcg: parseFloat(row.tcg) || 0,
            vcg: parseFloat(row.vcg) || 0,
            iy: parseFloat(row.iy) || 0,
            interpolation_used: 'trim_only'
        };
    }

    const { lowerUllage, upperUllage } = ullageBounds;
    
    const query = `
        SELECT ullage, ${lowerTrim.column}, ${upperTrim.column}, lcg, tcg, vcg, iy, sound
        FROM main_sounding_trim_data 
        WHERE compartment_id = $1 AND ullage IN ($2, $3)
        ORDER BY ullage
    `;
    
    const result = await pool.query(query, [compartmentId, lowerUllage, upperUllage]);
    if (result.rows.length !== 2) {
        throw new Error('Insufficient data for bilinear interpolation');
    }

    const lowerUllageRow = result.rows[0];
    const upperUllageRow = result.rows[1];

    const volumeAtLowerUllage = linearInterpolate(
        lowerTrim.value, parseFloat(lowerUllageRow[lowerTrim.column]) || 0,
        upperTrim.value, parseFloat(lowerUllageRow[upperTrim.column]) || 0,
        parseFloat(targetTrim)
    );

    const volumeAtUpperUllage = linearInterpolate(
        lowerTrim.value, parseFloat(upperUllageRow[lowerTrim.column]) || 0,
        upperTrim.value, parseFloat(upperUllageRow[upperTrim.column]) || 0,
        parseFloat(targetTrim)
    );

    const finalVolume = linearInterpolate(
        lowerUllage, volumeAtLowerUllage,
        upperUllage, volumeAtUpperUllage,
        parseFloat(targetUllage)
    );

    const interpolateProperty = (prop) => {
        const lowerUllageProp = parseFloat(lowerUllageRow[prop]) || 0;
        const upperUllageProp = parseFloat(upperUllageRow[prop]) || 0;
        return linearInterpolate(lowerUllage, lowerUllageProp, upperUllage, upperUllageProp, parseFloat(targetUllage));
    };

    return {
        volume: finalVolume,
        sound: Math.round(linearInterpolate(
            lowerUllage, parseFloat(lowerUllageRow.sound) || 0, 
            upperUllage, parseFloat(upperUllageRow.sound) || 0, 
            parseFloat(targetUllage)
        )) || null,
        ullage: parseFloat(targetUllage),
        lcg: interpolateProperty('lcg'),
        tcg: interpolateProperty('tcg'),
        vcg: interpolateProperty('vcg'),
        iy: interpolateProperty('iy'),
        interpolation_used: 'bilinear',
        interpolation_bounds: {
            ullage: { lower: lowerUllage, upper: upperUllage },
            trim: { lower: lowerTrim.value, upper: upperTrim.value }
        }
    };
};

const getCompleteSoundingData = async (compartmentId, targetUllage, targetTrim, targetHeel) => {
    const baseSoundingData = await getSoundingDataWithInterpolation(compartmentId, targetUllage, targetTrim);
    
    let heelCorrectionData = null;
    let finalVolume = baseSoundingData.volume;
    
    if (targetHeel !== undefined && targetHeel !== null && targetHeel !== 0) {
        try {
            heelCorrectionData = await getHeelCorrectionWithInterpolation(compartmentId, targetUllage, targetHeel);
            finalVolume = baseSoundingData.volume + heelCorrectionData.heel_correction;
        } catch (heelError) {
            heelCorrectionData = {
                error: heelError.message,
                heel_correction: 0
            };
        }
    }

    return {
        base_volume: baseSoundingData.volume,
        heel_correction: heelCorrectionData ? heelCorrectionData.heel_correction : 0,
        final_volume: finalVolume,
        sound: baseSoundingData.sound,
        ullage: baseSoundingData.ullage,
        lcg: baseSoundingData.lcg,
        tcg: baseSoundingData.tcg,
        vcg: baseSoundingData.vcg,
        iy: baseSoundingData.iy,
        main_interpolation: {
            type: baseSoundingData.interpolation_used,
            bounds: baseSoundingData.interpolation_bounds || null
        },
        heel_interpolation: heelCorrectionData ? {
            type: heelCorrectionData.interpolation_used || 'error',
            bounds: heelCorrectionData.interpolation_bounds || null,
            error: heelCorrectionData.error || null
        } : null
    };
};

// =====================================================
// MAIN LAMBDA HANDLER
// =====================================================

exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Code, x-admin-code',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };
    
    if (event.requestContext.http.method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }
    
    try {
        const isConnected = await testConnection();
        if (!isConnected) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'Database connection failed'
                })
            };
        }

        const method = event.requestContext.http.method;
        const path = event.requestContext.http.path;
        const pathParams = event.pathParameters || {};
        
        console.log(`${method} ${path}`);
        
        // ===== NEW BUNKERWATCH ROUTES =====
        
        // GET /vessels
        if (method === 'GET' && path === '/vessels') {
            const result = await getVessels();
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(result)
            };
        }
        
        // GET /vessel/{vessel_id}/info
        if (method === 'GET' && path.match(/^\/vessel\/[^/]+\/info$/)) {
            const vesselId = pathParams.vessel_id || path.split('/')[2];
            const result = await getVesselInfo(vesselId);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(result)
            };
        }
        
        // GET /vessel/{vessel_id}/data-package
        if (method === 'GET' && path.match(/^\/vessel\/[^/]+\/data-package$/)) {
            const vesselId = pathParams.vessel_id || path.split('/')[2];
            // Enforce signature if enabled
            const queryParams = event.queryStringParameters || {};
            const sig = validateSignedRequest(vesselId, queryParams);
            if (!sig.valid) {
                return {
                    statusCode: 401,
                    headers,
                    body: JSON.stringify({ success: false, error: 'Unauthorized', reason: sig.reason })
                };
            }
            const result = await generateVesselDataPackage(vesselId);
            
            // Compress large responses to avoid Lambda payload limit
            const jsonString = JSON.stringify(result);
            const jsonSize = Buffer.byteLength(jsonString, 'utf8');
            
            console.log(`Response size: ${Math.round(jsonSize / 1024)}KB`);
            
            // If response is > 5MB, compress it
            if (jsonSize > 5 * 1024 * 1024) {
                console.log('Compressing response with gzip...');
                const compressed = await gzip(jsonString);
                const compressedSize = Buffer.byteLength(compressed);
                console.log(`Compressed size: ${Math.round(compressedSize / 1024)}KB (${Math.round(compressedSize / jsonSize * 100)}%)`);
                
                return {
                    statusCode: 200,
                    headers: {
                        ...headers,
                        'Content-Encoding': 'gzip',
                        'Content-Type': 'application/json'
                    },
                    body: compressed.toString('base64'),
                    isBase64Encoded: true
                };
            }
            
            return {
                statusCode: 200,
                headers,
                body: jsonString
            };
        }

        // POST /admin/vessel/{vessel_id}/signed-link
        if (method === 'POST' && path.match(/^\/admin\/vessel\/[^/]+\/signed-link$/)) {
            const vesselId = pathParams.vessel_id || path.split('/')[3];
            // Simple admin code header check
            const adminHeader = (event.headers?.['x-admin-code'] || event.headers?.['X-Admin-Code'] || '').toString();
            if (!ADMIN_CODE || adminHeader !== ADMIN_CODE) {
                return {
                    statusCode: 403,
                    headers,
                    body: JSON.stringify({ success: false, error: 'Forbidden' })
                };
            }
            const body = JSON.parse(event.body || '{}');
            const ttlSeconds = parseInt(body.ttl_seconds || '86400', 10); // default 1 day
            const now = Math.floor(Date.now() / 1000);
            const expires = now + Math.max(60, Math.min(ttlSeconds, 30 * 24 * 3600));
            const token = createSignedToken(vesselId, expires);
            if (!token) {
                return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Signing not configured' }) };
            }
            const base = event.requestContext?.http?.path?.replace(/\/admin\/vessel\/.+$/, '') || '';
            const origin = (event.headers['x-forwarded-proto'] && event.headers['x-forwarded-host'])
              ? `${event.headers['x-forwarded-proto']}://${event.headers['x-forwarded-host']}`
              : '';
            const link = `${origin}/vessel/${vesselId}/data-package?expires=${expires}&token=${token}`;
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, url: link, expires }) };
        }
        
        // GET /vessel/{vessel_id}/compartments
        if (method === 'GET' && path.match(/^\/vessel\/[^/]+\/compartments$/)) {
            const vesselId = pathParams.vessel_id || path.split('/')[2];
            const result = await getVesselCompartments(vesselId);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(result)
            };
        }

        // POST /vessel/{vessel_id}/check-update
        // Simple implementation: respond with no update available for now.
        if (method === 'POST' && path.match(/^\/vessel\/[^/]+\/check-update$/)) {
            const vesselId = pathParams.vessel_id || path.split('/')[2];
            const body = JSON.parse(event.body || '{}');
            const currentVersion = body.current_version || 1;
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    vessel_id: vesselId,
                    update_available: false,
                    latest_version: currentVersion
                })
            };
        }
        
        // POST /vessel/{vessel_id}/sync-soundings
        if (method === 'POST' && path.match(/^\/vessel\/[^/]+\/sync-soundings$/)) {
            const vesselId = pathParams.vessel_id || path.split('/')[2];
            const body = JSON.parse(event.body || '{}');
            
            // Pass full payload (soundings + summary)
            const result = await syncSoundings(vesselId, body);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(result)
            };
        }
        
        // POST /vessel/{vessel_id}/sync-bunkering
        if (method === 'POST' && path.match(/^\/vessel\/[^/]+\/sync-bunkering$/)) {
            const vesselId = pathParams.vessel_id || path.split('/')[2];
            const body = JSON.parse(event.body || '{}');
            const bunkeringOps = body.bunkering_operations || [];
            
            const result = await syncBunkering(vesselId, bunkeringOps);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(result)
            };
        }
        
        // ===== EXISTING ROUTES (Keep for backward compatibility) =====
        
        // GET /compartments
        if (method === 'GET' && (path === '/compartments' || path === '/' || path.includes('compartments'))) {
            const query = 'SELECT compartment_id, compartment_name FROM compartments ORDER BY compartment_name';
            const result = await pool.query(query);
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    action: 'get_compartments',
                    data: result.rows,
                    count: result.rows.length
                })
            };
        }
        
        // POST /sounding
        if (method === 'POST' && (path === '/sounding' || path === '//sounding' || path.includes('sounding'))) {
            const body = JSON.parse(event.body || '{}');
            const { compartment_id, ullage, trim, heel } = body;
            
            if (!compartment_id || ullage === undefined || trim === undefined) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'Missing required parameters: compartment_id, ullage, trim'
                    })
                };
            }
            
            try {
                const soundingData = await getCompleteSoundingData(compartment_id, ullage, trim, heel);
                
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        action: 'get_sounding',
                        data: {
                            ...soundingData,
                            trim: parseFloat(trim),
                            heel: heel !== undefined ? parseFloat(heel) : null,
                            compartment_id: parseInt(compartment_id)
                        }
                    })
                };
            } catch (interpolationError) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: interpolationError.message
                    })
                };
            }
        }
        
        // Default 404
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({
                success: false,
                error: 'Route not found',
                available_routes: [
                    'GET  /vessels',
                    'GET  /vessel/{id}/info',
                    'GET  /vessel/{id}/data-package',
                    'GET  /vessel/{id}/compartments',
                    'POST /vessel/{id}/sync-soundings',
                    'POST /vessel/{id}/sync-bunkering',
                    'GET  /compartments (legacy)',
                    'POST /sounding (legacy)'
                ]
            })
        };
        
    } catch (error) {
        console.error('[LAMBDA] Error:', error.message);
        console.error('[LAMBDA] Stack:', error.stack);
        console.error('[LAMBDA] Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                success: false,
                error: 'Internal server error',
                message: error.message,
                details: process.env.NODE_ENV === 'development' ? error.stack : undefined
            })
        };
    }
};

