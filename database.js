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
                clerk_id VARCHAR(32),
                plaintiff_ids TEXT NOT NULL,
                defendant_ids TEXT NOT NULL,
                case_link TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(20) DEFAULT 'active'
            )
        `);
        
        // Add migration for existing tables
        await pool.query(`
            DO $$ 
            BEGIN 
                -- Check if the old columns exist and migrate
                IF EXISTS (SELECT 1 FROM information_schema.columns 
                    WHERE table_name='cases' AND column_name='plaintiff_id') 
                THEN
                    -- Add new columns if they don't exist
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                        WHERE table_name='cases' AND column_name='plaintiff_ids') 
                    THEN
                        ALTER TABLE cases ADD COLUMN plaintiff_ids TEXT;
                        ALTER TABLE cases ADD COLUMN defendant_ids TEXT;
                    END IF;
                    
                    -- Migrate data from old columns to new
                    UPDATE cases 
                    SET plaintiff_ids = plaintiff_id,
                        defendant_ids = defendant_id
                    WHERE plaintiff_ids IS NULL;
                    
                    -- Make clerk_id nullable
                    ALTER TABLE cases ALTER COLUMN clerk_id DROP NOT NULL;
                    
                    -- Drop old columns
                    ALTER TABLE cases DROP COLUMN IF EXISTS plaintiff_id;
                    ALTER TABLE cases DROP COLUMN IF EXISTS defendant_id;
                END IF;
            END $$;
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
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS erpo_orders (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_code VARCHAR(50) NOT NULL,
                target_user_id VARCHAR(32) NOT NULL,
                issued_by VARCHAR(32) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deadline TIMESTAMP NOT NULL,
                surrendered BOOLEAN DEFAULT FALSE,
                surrendered_at TIMESTAMP,
                pdf_receipt_url TEXT,
                deadline_notified BOOLEAN DEFAULT FALSE
            )
        `);
        
        // Add deadline_notified column if it doesn't exist
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                    WHERE table_name='erpo_orders' AND column_name='deadline_notified') 
                THEN
                    ALTER TABLE erpo_orders ADD COLUMN deadline_notified BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS firearms_relinquishments (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_code VARCHAR(50) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                work_firearms BOOLEAN NOT NULL,
                firearms_owned TEXT NOT NULL,
                ammunition_owned TEXT NOT NULL,
                surrendered_all BOOLEAN NOT NULL,
                understand_prohibition BOOLEAN NOT NULL,
                emergency_notice BOOLEAN NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS staff_invoices (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_id VARCHAR(50) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                role_type VARCHAR(50) NOT NULL,
                duty_type VARCHAR(50),
                hours_worked DECIMAL(5, 2),
                base_pay DECIMAL(10, 2) NOT NULL,
                hourly_rate DECIMAL(10, 2),
                reimbursements DECIMAL(10, 2) DEFAULT 0,
                receipt_url TEXT,
                total_amount DECIMAL(10, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                invoice_number VARCHAR(20) NOT NULL
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS dej_orders (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_code VARCHAR(50) NOT NULL,
                target_user_id VARCHAR(32) NOT NULL,
                issued_by VARCHAR(32) NOT NULL,
                duration VARCHAR(50) NOT NULL,
                conditions TEXT NOT NULL,
                suspended_sentence TEXT NOT NULL,
                order_link TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_checkin TIMESTAMP,
                next_checkin TIMESTAMP NOT NULL,
                checkin_count INTEGER DEFAULT 0,
                status VARCHAR(20) DEFAULT 'active'
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS hearings (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_code VARCHAR(50) NOT NULL,
                hearing_date TIMESTAMP NOT NULL,
                timezone VARCHAR(50) NOT NULL,
                location TEXT NOT NULL,
                is_virtual BOOLEAN NOT NULL,
                assigned_parties TEXT NOT NULL,
                created_by VARCHAR(32) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                one_hour_reminder_sent BOOLEAN DEFAULT FALSE,
                start_reminder_sent BOOLEAN DEFAULT FALSE
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fee_invoices (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                case_code VARCHAR(50) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                fee_category VARCHAR(100) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                invoice_number VARCHAR(20) NOT NULL UNIQUE,
                status VARCHAR(20) DEFAULT 'unpaid',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                paid_at TIMESTAMP,
                paid_by VARCHAR(32)
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

async function createCase(guildId, channelId, caseCode, judgeId, clerkId, plaintiffIds, defendantIds, caseLink) {
    const query = `
        INSERT INTO cases (guild_id, channel_id, case_code, judge_id, clerk_id, plaintiff_ids, defendant_ids, case_link)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, judgeId, clerkId, plaintiffIds, defendantIds, caseLink];
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

async function getCasesByJudge(guildId, judgeId) {
    const query = `
        SELECT * FROM cases 
        WHERE guild_id = $1 AND judge_id = $2
        ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [guildId, judgeId]);
    return result.rows;
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

async function createERPOOrder(guildId, channelId, caseCode, targetUserId, issuedBy, deadline) {
    const query = `
        INSERT INTO erpo_orders (guild_id, channel_id, case_code, target_user_id, issued_by, deadline)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, targetUserId, issuedBy, deadline];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function getExpiredERPOOrders() {
    const query = `
        SELECT * FROM erpo_orders 
        WHERE deadline <= CURRENT_TIMESTAMP 
        AND surrendered = FALSE
        AND deadline_notified = FALSE
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function markERPOSurrendered(id, pdfUrl) {
    const query = `
        UPDATE erpo_orders 
        SET surrendered = TRUE, surrendered_at = CURRENT_TIMESTAMP, pdf_receipt_url = $2
        WHERE id = $1
        RETURNING *
    `;
    const result = await pool.query(query, [id, pdfUrl]);
    return result.rows[0];
}

async function getActiveERPOByUser(guildId, channelId, userId) {
    const query = `
        SELECT * FROM erpo_orders 
        WHERE guild_id = $1 
        AND channel_id = $2 
        AND target_user_id = $3 
        AND surrendered = FALSE
        ORDER BY created_at DESC
        LIMIT 1
    `;
    const result = await pool.query(query, [guildId, channelId, userId]);
    return result.rows[0];
}

async function liftERPO(id) {
    const query = `
        DELETE FROM erpo_orders 
        WHERE id = $1
        RETURNING *
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
}

async function markERPODeadlineNotified(id) {
    const query = `
        UPDATE erpo_orders 
        SET deadline_notified = TRUE
        WHERE id = $1
        RETURNING *
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
}

async function createFirearmsRelinquishment(guildId, channelId, caseCode, userId, workFirearms, firearmsOwned, ammunitionOwned, surrenderedAll, understandProhibition, emergencyNotice) {
    const query = `
        INSERT INTO firearms_relinquishments 
        (guild_id, channel_id, case_code, user_id, work_firearms, firearms_owned, ammunition_owned, surrendered_all, understand_prohibition, emergency_notice)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, userId, workFirearms, firearmsOwned, ammunitionOwned, surrenderedAll, understandProhibition, emergencyNotice];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function createStaffInvoice(guildId, channelId, caseId, userId, roleType, dutyType, hoursWorked, basePay, hourlyRate, reimbursements, receiptUrl, totalAmount, invoiceNumber) {
    const query = `
        INSERT INTO staff_invoices 
        (guild_id, channel_id, case_id, user_id, role_type, duty_type, hours_worked, base_pay, hourly_rate, reimbursements, receipt_url, total_amount, invoice_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
    `;
    const values = [guildId, channelId, caseId, userId, roleType, dutyType, hoursWorked, basePay, hourlyRate, reimbursements, receiptUrl, totalAmount, invoiceNumber];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function createDEJOrder(guildId, channelId, caseCode, targetUserId, issuedBy, duration, conditions, suspendedSentence, orderLink, nextCheckin) {
    const query = `
        INSERT INTO dej_orders 
        (guild_id, channel_id, case_code, target_user_id, issued_by, duration, conditions, suspended_sentence, order_link, next_checkin)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, targetUserId, issuedBy, duration, conditions, suspendedSentence, orderLink, nextCheckin];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function getDEJCheckinsDue() {
    const query = `
        SELECT * FROM dej_orders 
        WHERE next_checkin <= CURRENT_TIMESTAMP 
        AND status = 'active'
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function updateDEJCheckin(id) {
    const query = `
        UPDATE dej_orders 
        SET last_checkin = CURRENT_TIMESTAMP,
            next_checkin = CURRENT_TIMESTAMP + INTERVAL '5 days',
            checkin_count = checkin_count + 1
        WHERE id = $1
        RETURNING *
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
}

async function createHearing(guildId, channelId, caseCode, hearingDate, timezone, location, isVirtual, assignedParties, createdBy) {
    const query = `
        INSERT INTO hearings 
        (guild_id, channel_id, case_code, hearing_date, timezone, location, is_virtual, assigned_parties, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, hearingDate, timezone, location, isVirtual, assignedParties, createdBy];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function getUpcomingHearingReminders() {
    const query = `
        SELECT * FROM hearings 
        WHERE (
            (hearing_date - INTERVAL '1 hour' <= CURRENT_TIMESTAMP AND one_hour_reminder_sent = FALSE)
            OR 
            (hearing_date <= CURRENT_TIMESTAMP AND start_reminder_sent = FALSE)
        )
        AND hearing_date >= CURRENT_TIMESTAMP - INTERVAL '1 day'
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function markHearingReminderSent(id, reminderType) {
    const column = reminderType === 'one_hour' ? 'one_hour_reminder_sent' : 'start_reminder_sent';
    const query = `
        UPDATE hearings 
        SET ${column} = TRUE
        WHERE id = $1
        RETURNING *
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
}

async function createFeeInvoice(guildId, channelId, caseCode, userId, feeCategory, amount, invoiceNumber) {
    const query = `
        INSERT INTO fee_invoices 
        (guild_id, channel_id, case_code, user_id, fee_category, amount, invoice_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
    `;
    const values = [guildId, channelId, caseCode, userId, feeCategory, amount, invoiceNumber];
    const result = await pool.query(query, values);
    return result.rows[0];
}

async function getFeesByUserAndCase(guildId, userId, caseCode) {
    const query = `
        SELECT * FROM fee_invoices 
        WHERE guild_id = $1 AND user_id = $2 AND case_code = $3
        ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [guildId, userId, caseCode]);
    return result.rows;
}

async function getFeeByInvoiceNumber(guildId, invoiceNumber) {
    const query = `
        SELECT * FROM fee_invoices 
        WHERE guild_id = $1 AND invoice_number = $2
    `;
    const result = await pool.query(query, [guildId, invoiceNumber]);
    return result.rows[0];
}

async function markFeePaid(guildId, invoiceNumber, paidBy) {
    const query = `
        UPDATE fee_invoices 
        SET status = 'paid', paid_at = CURRENT_TIMESTAMP, paid_by = $3
        WHERE guild_id = $1 AND invoice_number = $2 AND status = 'unpaid'
        RETURNING *
    `;
    const result = await pool.query(query, [guildId, invoiceNumber, paidBy]);
    return result.rows[0];
}

async function getAllFeesByUser(guildId, userId) {
    const query = `
        SELECT * FROM fee_invoices 
        WHERE guild_id = $1 AND user_id = $2
        ORDER BY case_code, created_at DESC
    `;
    const result = await pool.query(query, [guildId, userId]);
    return result.rows;
}

async function searchClosedCases(guildId, keyword) {
    const searchPattern = `%${keyword.toLowerCase()}%`;
    
    // Debug: First check if there are ANY closed cases
    const debugQuery = `
        SELECT COUNT(*) as count, status 
        FROM cases 
        WHERE guild_id = $1 
        GROUP BY status
    `;
    const debugResult = await pool.query(debugQuery, [guildId]);
    console.log('Debug - Cases by status:', debugResult.rows);
    console.log('Debug - Searching for keyword:', keyword, 'Pattern:', searchPattern);
    
    // Also search without status filter to debug
    const allMatchesQuery = `
        SELECT case_code, status, case_link 
        FROM cases 
        WHERE guild_id = $1 
        AND (
            LOWER(case_code) LIKE $2 
            OR LOWER(plaintiff_ids) LIKE $2
            OR LOWER(defendant_ids) LIKE $2
            OR LOWER(case_link) LIKE $2
        )
        LIMIT 5
    `;
    const allMatches = await pool.query(allMatchesQuery, [guildId, searchPattern]);
    console.log('Debug - All matches (regardless of status):', allMatches.rows);
    
    const query = `
        SELECT * FROM cases 
        WHERE guild_id = $1 
        AND status = 'closed'
        AND (
            LOWER(case_code) LIKE $2 
            OR LOWER(plaintiff_ids) LIKE $2
            OR LOWER(defendant_ids) LIKE $2
            OR LOWER(case_link) LIKE $2
        )
        ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [guildId, searchPattern]);
    console.log('Debug - Found closed cases:', result.rows.length);
    return result.rows;
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
    getCasesByJudge,
    createAppealDeadline,
    getExpiredAppealDeadlines,
    removePartyAccess,
    fileAppealNotice,
    getActiveAppealDeadline,
    createAppealFiling,
    createFinancialDisclosure,
    createERPOOrder,
    getExpiredERPOOrders,
    markERPOSurrendered,
    getActiveERPOByUser,
    liftERPO,
    markERPODeadlineNotified,
    createFirearmsRelinquishment,
    createStaffInvoice,
    createDEJOrder,
    getDEJCheckinsDue,
    updateDEJCheckin,
    createHearing,
    getUpcomingHearingReminders,
    markHearingReminderSent,
    createFeeInvoice,
    getFeesByUserAndCase,
    getFeeByInvoiceNumber,
    markFeePaid,
    getAllFeesByUser,
    searchClosedCases
};