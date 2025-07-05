const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS discovery_deadlines (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                case_type VARCHAR(20) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deadline TIMESTAMP NOT NULL,
                notified BOOLEAN DEFAULT FALSE
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cases (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_code VARCHAR(50) NOT NULL,
                judge_id VARCHAR(32) NOT NULL,
                clerk_id VARCHAR(32) NOT NULL,
                plaintiff_id VARCHAR(32) NOT NULL,
                defendant_id VARCHAR(32) NOT NULL,
                case_link TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(20) DEFAULT 'active'
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS gag_orders (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                issued_by VARCHAR(32) NOT NULL,
                reason TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                lifted_at TIMESTAMP,
                active BOOLEAN DEFAULT TRUE
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appeal_deadlines (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                plaintiff_id VARCHAR(32) NOT NULL,
                defendant_id VARCHAR(32) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deadline TIMESTAMP NOT NULL,
                processed BOOLEAN DEFAULT FALSE,
                appeal_filed BOOLEAN DEFAULT FALSE,
                appeal_filed_by VARCHAR(32),
                appeal_filed_at TIMESTAMP
            )
        `);
        
        // Add missing columns if they don't exist (for existing databases)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                    WHERE table_name='appeal_deadlines' AND column_name='appeal_filed') 
                THEN
                    ALTER TABLE appeal_deadlines ADD COLUMN appeal_filed BOOLEAN DEFAULT FALSE;
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                    WHERE table_name='appeal_deadlines' AND column_name='appeal_filed_by') 
                THEN
                    ALTER TABLE appeal_deadlines ADD COLUMN appeal_filed_by VARCHAR(32);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                    WHERE table_name='appeal_deadlines' AND column_name='appeal_filed_at') 
                THEN
                    ALTER TABLE appeal_deadlines ADD COLUMN appeal_filed_at TIMESTAMP;
                END IF;
            END $$;
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appeal_filings (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_code VARCHAR(50) NOT NULL,
                filed_by VARCHAR(32) NOT NULL,
                writ_link TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                scor_message_id VARCHAR(32)
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS financial_disclosures (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                bank_balance DECIMAL(10, 2) NOT NULL,
                cash_balance DECIMAL(10, 2) NOT NULL,
                vehicles TEXT NOT NULL,
                vehicle_value DECIMAL(10, 2) NOT NULL,
                debts DECIMAL(10, 2) NOT NULL,
                owns_home BOOLEAN NOT NULL,
                net_worth DECIMAL(10, 2) NOT NULL,
                eligibility VARCHAR(20) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}

async function createDiscoveryDeadline(guildId, channelId, userId, caseType, deadline) {
    const query = `
        INSERT INTO discovery_deadlines (guild_id, channel_id, user_id, case_type, deadline)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `;
    const values = [guildId, channelId, userId, caseType, deadline];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function getExpiredDeadlines() {
    const query = `
        SELECT * FROM discovery_deadlines 
        WHERE deadline <= CURRENT_TIMESTAMP 
        AND notified = FALSE
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function markAsNotified(id) {
    const query = `
        UPDATE discovery_deadlines 
        SET notified = TRUE 
        WHERE id = $1
    `;
    await pool.query(query, [id]);
}

async function createCase(guildId, channelId, caseCode, judgeId, clerkId, plaintiffId, defendantId, caseLink) {
    const query = `
        INSERT INTO cases (guild_id, channel_id, case_code, judge_id, clerk_id, plaintiff_id, defendant_id, case_link)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, judgeId, clerkId, plaintiffId, defendantId, caseLink];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function createGagOrder(guildId, channelId, userId, issuedBy, reason) {
    const query = `
        INSERT INTO gag_orders (guild_id, channel_id, user_id, issued_by, reason)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `;
    const values = [guildId, channelId, userId, issuedBy, reason];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function updateGagOrderStatus(guildId, channelId, userId) {
    const query = `
        UPDATE gag_orders 
        SET active = FALSE, lifted_at = CURRENT_TIMESTAMP
        WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3 AND active = TRUE
    `;
    await pool.query(query, [guildId, channelId, userId]);
}

async function updateCaseStatus(guildId, channelId, status) {
    const query = `
        UPDATE cases 
        SET status = $3
        WHERE guild_id = $1 AND channel_id = $2
    `;
    await pool.query(query, [guildId, channelId, status]);
}

async function getCaseByChannel(guildId, channelId) {
    const query = `
        SELECT * FROM cases 
        WHERE guild_id = $1 AND channel_id = $2
    `;
    const result = await pool.query(query, [guildId, channelId]);
    return result.rows[0];
}

async function createAppealDeadline(guildId, channelId, plaintiffId, defendantId, deadline) {
    const query = `
        INSERT INTO appeal_deadlines (guild_id, channel_id, plaintiff_id, defendant_id, deadline)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `;
    const values = [guildId, channelId, plaintiffId, defendantId, deadline];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function getExpiredAppealDeadlines() {
    const query = `
        SELECT * FROM appeal_deadlines 
        WHERE deadline <= CURRENT_TIMESTAMP 
        AND processed = FALSE
        AND appeal_filed = FALSE
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function removePartyAccess(id) {
    const query = `
        UPDATE appeal_deadlines 
        SET processed = TRUE 
        WHERE id = $1
    `;
    await pool.query(query, [id]);
}

async function fileAppealNotice(guildId, channelId, filedBy) {
    const query = `
        UPDATE appeal_deadlines 
        SET appeal_filed = TRUE, appeal_filed_by = $3, appeal_filed_at = CURRENT_TIMESTAMP
        WHERE guild_id = $1 AND channel_id = $2 AND processed = FALSE
        RETURNING *
    `;
    const result = await pool.query(query, [guildId, channelId, filedBy]);
    return result.rows[0];
}

async function getActiveAppealDeadline(guildId, channelId) {
    const query = `
        SELECT * FROM appeal_deadlines 
        WHERE guild_id = $1 AND channel_id = $2 AND processed = FALSE
    `;
    const result = await pool.query(query, [guildId, channelId]);
    return result.rows[0];
}

async function createAppealFiling(guildId, channelId, caseCode, filedBy, writLink, scorMessageId) {
    const query = `
        INSERT INTO appeal_filings (guild_id, channel_id, case_code, filed_by, writ_link, scor_message_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, filedBy, writLink, scorMessageId];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function createFinancialDisclosure(guildId, channelId, userId, bankBalance, cashBalance, vehicles, vehicleValue, debts, ownsHome, netWorth, eligibility) {
    const query = `
        INSERT INTO financial_disclosures 
        (guild_id, channel_id, user_id, bank_balance, cash_balance, vehicles, vehicle_value, debts, owns_home, net_worth, eligibility)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
    `;
    const values = [guildId, channelId, userId, bankBalance, cashBalance, vehicles, vehicleValue, debts, ownsHome, netWorth, eligibility];
    const result = await pool.query(query, values);
    return result.rows[0];
}

module.exports = {
    initializeDatabase,
    createDiscoveryDeadline,
    getExpiredDeadlines,
    markAsNotified,
    createCase,
    createGagOrder,
    updateGagOrderStatus,
    updateCaseStatus,
    getCaseByChannel,
    createAppealDeadline,
    getExpiredAppealDeadlines,
    removePartyAccess,
    fileAppealNotice,
    getActiveAppealDeadline,
    createAppealFiling,
    createFinancialDisclosure
};