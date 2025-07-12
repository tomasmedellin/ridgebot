require('dotenv').config();
const { Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, AttachmentBuilder, Partials } = require('discord.js');
const { initializeDatabase, createDiscoveryDeadline, getExpiredDeadlines, markAsNotified, createCase, createGagOrder, updateGagOrderStatus, updateCaseStatus, getCaseByChannel, getCasesByJudge, createAppealDeadline, getExpiredAppealDeadlines, removePartyAccess, fileAppealNotice, getActiveAppealDeadline, createAppealFiling, createFinancialDisclosure, createERPOOrder, getExpiredERPOOrders, markERPOSurrendered, getActiveERPOByUser, liftERPO, markERPODeadlineNotified, createFirearmsRelinquishment, createStaffInvoice, createDEJOrder, getDEJCheckinsDue, updateDEJCheckin, createHearing, getUpcomingHearingReminders, markHearingReminderSent, createFeeInvoice, getFeesByUserAndCase, getFeeByInvoiceNumber, markFeePaid, getAllFeesByUser, searchClosedCases, getNextDCCode, createDutyCourt, getActiveDutyCourt, adjournDutyCourt, updateDutyCourtSessionStart, reassignCase } = require('./database');
const fs = require('fs').promises;
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib, rgb } = require('pdf-lib');
const axios = require('axios');
const moment = require('moment-timezone');

// Message cache for active case channels
const messageCache = new Map(); // channelId -> Map(messageId -> messageData)
const MAX_MESSAGES_PER_CHANNEL = 1000; // Limit cache size per channel

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel]
});

client.once(Events.ClientReady, async readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    
    await initializeDatabase();
    
    const discoveryCommand = new SlashCommandBuilder()
        .setName('discovery')
        .setDescription('Set a discovery deadline')
        .addStringOption(option =>
            option.setName('case_type')
                .setDescription('Type of case')
                .setRequired(true)
                .addChoices(
                    { name: 'Criminal (6 days)', value: 'criminal' },
                    { name: 'Civil (12 days)', value: 'civil' }
                ));
    
    const initializeCommand = new SlashCommandBuilder()
        .setName('initialize')
        .setDescription('Initialize a new case')
        .addStringOption(option =>
            option.setName('case_code')
                .setDescription('The case code')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('judge')
                .setDescription('The judge assigned to the case')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('plaintiffs')
                .setDescription('Plaintiff(s) - @mentions or usernames separated by spaces')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('case_link')
                .setDescription('Link to the case details')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('defendants')
                .setDescription('Defendant(s) - @mentions or usernames separated by spaces (optional for "In Re:" cases)')
                .setRequired(false))
        .addUserOption(option =>
            option.setName('clerk')
                .setDescription('The assigned clerk (optional)')
                .setRequired(false));
    
    const transcriptCommand = new SlashCommandBuilder()
        .setName('transcript')
        .setDescription('Generate an HTML transcript of this channel');
    
    const addCommand = new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add a user to this channel')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to add')
                .setRequired(true));
    
    const removeCommand = new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a user from this channel')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to remove')
                .setRequired(true));
    
    const sealCommand = new SlashCommandBuilder()
        .setName('seal')
        .setDescription('Make this channel private to non-parties');
    
    const unsealCommand = new SlashCommandBuilder()
        .setName('unseal')
        .setDescription('Restore channel visibility to everyone');
    
    const gagCommand = new SlashCommandBuilder()
        .setName('gag')
        .setDescription('Issue a gag order to mute a party')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to gag')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the gag order')
                .setRequired(true));
    
    const ungagCommand = new SlashCommandBuilder()
        .setName('ungag')
        .setDescription('Remove a gag order from a party')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to ungag')
                .setRequired(true));
    
    const closeCommand = new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close the case, generate transcript, and archive the channel');
    
    const fixCommand = new SlashCommandBuilder()
        .setName('fix')
        .setDescription('Reopen a closed case and move it back to active status');
    
    const reassignCommand = new SlashCommandBuilder()
        .setName('reassign')
        .setDescription('Transfer a case from one judge to another')
        .addUserOption(option =>
            option.setName('new_judge')
                .setDescription('The new judge to assign the case to')
                .setRequired(true));
    
    const finalRulingCommand = new SlashCommandBuilder()
        .setName('finalruling')
        .setDescription('Issue final ruling and start 24-hour appeal notice timer');
    
    const appealNoticeCommand = new SlashCommandBuilder()
        .setName('appealnotice')
        .setDescription('File a notice of appeal to the Supreme Court');
    
    const certiorariCommand = new SlashCommandBuilder()
        .setName('certiorari')
        .setDescription('File a writ of certiorari to the Supreme Court')
        .addStringOption(option =>
            option.setName('writ_filing')
                .setDescription('Google Drive link to your writ filing')
                .setRequired(true));
    
    const financialDisclosureCommand = new SlashCommandBuilder()
        .setName('financialdisclosure')
        .setDescription('Submit financial disclosure for court-appointed counsel eligibility')
        .addNumberOption(option =>
            option.setName('bank_balance')
                .setDescription('Current total bank account balance')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('cash_balance')
                .setDescription('Current cash on hand')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('vehicles')
                .setDescription('List vehicles with values (e.g., "2020 Honda Civic $15000")')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('debts')
                .setDescription('Total outstanding debts (loans, credit cards, etc.)')
                .setRequired(true))
        .addBooleanOption(option =>
            option.setName('own_home')
                .setDescription('Do you own your residence?')
                .setRequired(true));
    
    const erpoCommand = new SlashCommandBuilder()
        .setName('erpo')
        .setDescription('Issue an Extreme Risk Protection Order')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user subject to the ERPO')
                .setRequired(true));
    
    const lifterpoCommand = new SlashCommandBuilder()
        .setName('lifterpo')
        .setDescription('Lift an Extreme Risk Protection Order')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user whose ERPO should be lifted')
                .setRequired(true));
    
    const firearmsRelinquishmentCommand = new SlashCommandBuilder()
        .setName('firearmsrelinquishment')
        .setDescription('Submit firearms relinquishment form')
        .addBooleanOption(option =>
            option.setName('work_firearms')
                .setDescription('Do you possess firearms for the nature of your work?')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('firearms_owned')
                .setDescription('List all firearms owned (e.g., "Glock 19, Remington 870, AR-15")')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('ammunition_owned')
                .setDescription('Describe ammunition owned (e.g., "200 rounds 9mm, 50 rounds 12ga")')
                .setRequired(true))
        .addBooleanOption(option =>
            option.setName('surrendered_all')
                .setDescription('Have you surrendered all firearms to Ridgeway County Sheriff?')
                .setRequired(true))
        .addBooleanOption(option =>
            option.setName('understand_prohibition')
                .setDescription('Do you understand you cannot acquire firearms licenses?')
                .setRequired(true));
    
    const staffInvoiceCommand = new SlashCommandBuilder()
        .setName('staffinvoice')
        .setDescription('Submit staff invoice for payment')
        .addStringOption(option =>
            option.setName('case_id')
                .setDescription('Case ID for this invoice')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('role')
                .setDescription('Your role in this case')
                .setRequired(true)
                .addChoices(
                    { name: 'Riding Justice', value: 'riding_justice' },
                    { name: 'Superior Court Judge', value: 'superior_court_judge' },
                    { name: 'Magistrate', value: 'magistrate' },
                    { name: 'Public Defender', value: 'public_defender' },
                    { name: 'Clerk', value: 'clerk' },
                    { name: 'Public Defenders Office', value: 'public_defenders_office' }
                ))
        .addStringOption(option =>
            option.setName('duty_type')
                .setDescription('Type of duty (for Public Defender only)')
                .setRequired(false)
                .addChoices(
                    { name: 'Duty Counsel', value: 'duty_counsel' },
                    { name: 'Regular Counsel', value: 'regular_counsel' }
                ))
        .addNumberOption(option =>
            option.setName('hours')
                .setDescription('Hours worked')
                .setRequired(false))
        .addNumberOption(option =>
            option.setName('reimbursements')
                .setDescription('Work-related reimbursements (Public Defender only)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('receipt_url')
                .setDescription('Receipt URL for reimbursements (Public Defender only)')
                .setRequired(false));
    
    const minuteOrderCommand = new SlashCommandBuilder()
        .setName('minuteorder')
        .setDescription('Issue a minute order')
        .addUserOption(option =>
            option.setName('party')
                .setDescription('The party this order is directed at')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('order_text')
                .setDescription('The text of the order')
                .setRequired(true));
    
    const dejCommand = new SlashCommandBuilder()
        .setName('dej')
        .setDescription('Issue a Deferred Entry of Judgment order')
        .addUserOption(option =>
            option.setName('party')
                .setDescription('The party this DEJ is directed at')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Duration of the DEJ (e.g., "6 months", "1 year")')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('conditions')
                .setDescription('Conditions of probation (separate multiple with semicolons)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('suspended_sentence')
                .setDescription('The suspended sentence details')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('order_link')
                .setDescription('Google Drive link to courtesy copy of order')
                .setRequired(true));
    
    const hearingCommand = new SlashCommandBuilder()
        .setName('hearing')
        .setDescription('Schedule a hearing with reminders')
        .addStringOption(option =>
            option.setName('date')
                .setDescription('Hearing date (MM/DD/YYYY)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('time')
                .setDescription('Hearing time (HH:MM AM/PM)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('timezone')
                .setDescription('Timezone')
                .setRequired(true)
                .addChoices(
                    { name: 'Eastern Time (ET)', value: 'America/New_York' },
                    { name: 'Central Time (CT)', value: 'America/Chicago' },
                    { name: 'Mountain Time (MT)', value: 'America/Denver' },
                    { name: 'Pacific Time (PT)', value: 'America/Los_Angeles' },
                    { name: 'Alaska Time (AKT)', value: 'America/Anchorage' },
                    { name: 'Hawaii Time (HT)', value: 'Pacific/Honolulu' },
                    { name: 'GMT/UTC', value: 'UTC' },
                    { name: 'British Time (BST/GMT)', value: 'Europe/London' },
                    { name: 'Central European Time (CET)', value: 'Europe/Paris' },
                    { name: 'Eastern European Time (EET)', value: 'Europe/Athens' },
                    { name: 'Moscow Time (MSK)', value: 'Europe/Moscow' },
                    { name: 'India Standard Time (IST)', value: 'Asia/Kolkata' },
                    { name: 'China Standard Time (CST)', value: 'Asia/Shanghai' },
                    { name: 'Japan Standard Time (JST)', value: 'Asia/Tokyo' },
                    { name: 'Korea Standard Time (KST)', value: 'Asia/Seoul' },
                    { name: 'Singapore Time (SGT)', value: 'Asia/Singapore' },
                    { name: 'Australian Eastern Time (AET)', value: 'Australia/Sydney' },
                    { name: 'Australian Western Time (AWT)', value: 'Australia/Perth' },
                    { name: 'New Zealand Time (NZST)', value: 'Pacific/Auckland' },
                    { name: 'Dubai Time (GST)', value: 'Asia/Dubai' },
                    { name: 'Israel Standard Time (IST)', value: 'Asia/Jerusalem' },
                    { name: 'South Africa Time (SAST)', value: 'Africa/Johannesburg' },
                    { name: 'Brazil Time (BRT)', value: 'America/Sao_Paulo' },
                    { name: 'Argentina Time (ART)', value: 'America/Argentina/Buenos_Aires' },
                    { name: 'Mexico City Time (CST)', value: 'America/Mexico_City' }
                ))
        .addStringOption(option =>
            option.setName('location')
                .setDescription('Location of the hearing')
                .setRequired(true))
        .addBooleanOption(option =>
            option.setName('virtual')
                .setDescription('Is this a virtual hearing?')
                .setRequired(true));
    
    const noaCommand = new SlashCommandBuilder()
        .setName('noa')
        .setDescription('File a Notice of Appearance')
        .addChannelOption(option =>
            option.setName('case_channel')
                .setDescription('The case channel')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('appearing_for')
                .setDescription('Appearing on behalf of')
                .setRequired(true)
                .addChoices(
                    { name: 'Plaintiff', value: 'plaintiff' },
                    { name: 'Defendant', value: 'defendant' }
                ))
        .addStringOption(option =>
            option.setName('bar_number')
                .setDescription('Your Ridgeway Bar Number')
                .setRequired(true));
    
    const summonCommand = new SlashCommandBuilder()
        .setName('summon')
        .setDescription('Issue a legal summons to a user')
        .addStringOption(option =>
            option.setName('target')
                .setDescription('The nickname of the user to summon')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('plaintiff')
                .setDescription('The plaintiff in the case')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('case_link')
                .setDescription('Link to the case details')
                .setRequired(true));

    const publicSummonsCommand = new SlashCommandBuilder()
        .setName('publicsummons')
        .setDescription('Issue a public summons (civil or criminal) to a user')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Type of summons')
                .setRequired(true)
                .addChoices(
                    { name: 'Civil', value: 'civil' },
                    { name: 'Criminal', value: 'criminal' }
                ))
        .addStringOption(option =>
            option.setName('target')
                .setDescription('The username to summon')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('case_channel')
                .setDescription('The case channel')
                .setRequired(true));
    
    const imposeFeeCommand = new SlashCommandBuilder()
        .setName('imposefee')
        .setDescription('Imposes court fee within a case')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The user to impose the fee on')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Fee category')
                .setRequired(true)
                .addChoices(
                    { name: 'Initial Motion Civil Case Cost ($435)', value: 'initial_civil' },
                    { name: 'Initial Motion Small Claims Case ($75)', value: 'initial_small_claims' },
                    { name: 'Summary Judgement Motion ($500)', value: 'summary_judgement' },
                    { name: 'General Motion Cost ($100)', value: 'general_motion' },
                    { name: 'Small Claims Frequent Filer Fee ($100)', value: 'frequent_filer' },
                    { name: 'Summons ($75)', value: 'summons' },
                    { name: 'Summons by Publication ($200)', value: 'summons_publication' },
                    { name: 'Hearing Scheduling ($60)', value: 'hearing_scheduling' },
                    { name: 'Petition for Vehicle Forfeiture ($100)', value: 'vehicle_forfeiture' },
                    { name: 'Petition for General Forfeiture ($200)', value: 'general_forfeiture' }
                ));
    
    const feeStatusCommand = new SlashCommandBuilder()
        .setName('feestatus')
        .setDescription('Displays a user fee status during a case')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The user to check fee status')
                .setRequired(true));
    
    const executeFeeCommand = new SlashCommandBuilder()
        .setName('executefee')
        .setDescription('Mark a fee as paid')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The user who paid the fee')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('invoice')
                .setDescription('Fee invoice number')
                .setRequired(true));
    
    const sudoFeeStatusCommand = new SlashCommandBuilder()
        .setName('sudofeestatus')
        .setDescription('View fee balance status across all cases for a user')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The user to check all fees')
                .setRequired(true));
    
    const feeSheetCommand = new SlashCommandBuilder()
        .setName('feesheet')
        .setDescription('Display all available court fees and their costs');
    
    const fileSmallClaimCommand = new SlashCommandBuilder()
        .setName('filesmallclaim')
        .setDescription('Get the Small Claims form (S100) and filing instructions');
    
    const docketCommand = new SlashCommandBuilder()
        .setName('docket')
        .setDescription('Generate a docket of cases for a selected judge')
        .addUserOption(option =>
            option.setName('judge')
                .setDescription('Select a judge to view their case docket')
                .setRequired(true));
    
    const allSearchCommand = new SlashCommandBuilder()
        .setName('allsearch')
        .setDescription('Search through closed cases for a keyword')
        .addStringOption(option =>
            option.setName('keyword')
                .setDescription('The keyword to search for in closed cases')
                .setRequired(true));
    
    const dcSessionCommand = new SlashCommandBuilder()
        .setName('dcsession')
        .setDescription('Initialize a duty court session')
        .addUserOption(option =>
            option.setName('judge')
                .setDescription('The presiding judge')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('parties')
                .setDescription('Parties involved (space-separated @mentions or usernames)')
                .setRequired(true));
    
    const dcAdjournCommand = new SlashCommandBuilder()
        .setName('dcadjourn')
        .setDescription('Adjourn the duty court session');
    
    const dcMinuteOrderCommand = new SlashCommandBuilder()
        .setName('dcminuteorder')
        .setDescription('Issue a minute order in duty court')
        .addStringOption(option =>
            option.setName('order')
                .setDescription('The minute order text')
                .setRequired(true));
    
    try {
        await readyClient.application.commands.set([
            discoveryCommand.toJSON(),
            initializeCommand.toJSON(),
            transcriptCommand.toJSON(),
            addCommand.toJSON(),
            removeCommand.toJSON(),
            sealCommand.toJSON(),
            unsealCommand.toJSON(),
            gagCommand.toJSON(),
            ungagCommand.toJSON(),
            closeCommand.toJSON(),
            fixCommand.toJSON(),
            reassignCommand.toJSON(),
            finalRulingCommand.toJSON(),
            appealNoticeCommand.toJSON(),
            certiorariCommand.toJSON(),
            financialDisclosureCommand.toJSON(),
            erpoCommand.toJSON(),
            lifterpoCommand.toJSON(),
            firearmsRelinquishmentCommand.toJSON(),
            staffInvoiceCommand.toJSON(),
            minuteOrderCommand.toJSON(),
            dejCommand.toJSON(),
            hearingCommand.toJSON(),
            noaCommand.toJSON(),
            summonCommand.toJSON(),
            publicSummonsCommand.toJSON(),
            imposeFeeCommand.toJSON(),
            feeStatusCommand.toJSON(),
            executeFeeCommand.toJSON(),
            sudoFeeStatusCommand.toJSON(),
            feeSheetCommand.toJSON(),
            fileSmallClaimCommand.toJSON(),
            docketCommand.toJSON(),
            allSearchCommand.toJSON(),
            dcSessionCommand.toJSON(),
            dcAdjournCommand.toJSON(),
            dcMinuteOrderCommand.toJSON()
        ]);
        console.log('Successfully registered slash commands!');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
    
    setInterval(checkExpiredDeadlines, 60000); // Check every minute
    setInterval(checkExpiredAppealDeadlines, 60000); // Check every minute for appeal deadlines
    setInterval(checkExpiredERPODeadlines, 60000); // Check every minute for ERPO deadlines
    setInterval(checkDEJCheckins, 60000); // Check every minute for DEJ check-ins
    setInterval(checkHearingReminders, 60000); // Check every minute for hearing reminders
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;
    
    // Special handling for case party commands - check if user can send messages in channel
    const casePartyCommands = ['appealnotice', 'certiorari', 'financialdisclosure', 'firearmsrelinquishment'];
    
    // Commands that have their own permission checks
    const selfPermissionCommands = ['noa', 'staffinvoice'];
    
    if (casePartyCommands.includes(interaction.commandName)) {
        // If user has the allowed role, they can always use these commands
        if (!interaction.member.roles.cache.has(ALLOWED_ROLE_ID)) {
            // If no role, check if they can send messages in this channel (i.e., they're a case party)
            const channel = interaction.channel;
            const member = interaction.member;
            
            // Check if user has SEND_MESSAGES permission in this channel
            const canSendMessages = channel.permissionsFor(member).has(PermissionFlagsBits.SendMessages);
            
            if (!canSendMessages) {
                await interaction.reply({ 
                    content: 'Only case parties (those who can send messages in this channel) can use this command.', 
                    flags: 64 
                });
                return;
            }
            // If they can send messages, they're a case party - let them through
        }
    } else if (!selfPermissionCommands.includes(interaction.commandName)) {
        // For all other commands (except self-permission commands), require the allowed role
        if (!interaction.member.roles.cache.has(ALLOWED_ROLE_ID)) {
            await interaction.reply({ 
                content: 'You do not have permission to use this bot.', 
                flags: 64 
            });
            return;
        }
    }
    // Self-permission commands will handle their own permission checks
    
    if (interaction.commandName === 'discovery') {
        const caseType = interaction.options.getString('case_type');
        const days = caseType === 'criminal' ? 6 : 12;
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + days);
        
        try {
            await createDiscoveryDeadline(
                interaction.guildId,
                interaction.channelId,
                interaction.user.id,
                caseType,
                deadline
            );
            
            const embed = new EmbedBuilder()
                .setColor(caseType === 'criminal' ? 0xFF0000 : 0x0099FF)
                .setTitle('Discovery Deadline Set')
                .setDescription(`A ${caseType} discovery deadline has been set.`)
                .addFields(
                    { name: 'Case Type', value: caseType.charAt(0).toUpperCase() + caseType.slice(1), inline: true },
                    { name: 'Days', value: `${days} days`, inline: true },
                    { name: 'Deadline', value: deadline.toLocaleString(), inline: false }
                )
                .setTimestamp()
                .setFooter({ text: `Requested by ${interaction.user.username}` });
            
            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error setting discovery deadline:', error);
            await interaction.reply({ 
                content: 'An error occurred while setting the deadline.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'initialize') {
        await interaction.deferReply();
        
        const caseCode = interaction.options.getString('case_code');
        const judge = interaction.options.getUser('judge');
        const clerk = interaction.options.getUser('clerk'); // Optional
        const plaintiffsString = interaction.options.getString('plaintiffs');
        const defendantsString = interaction.options.getString('defendants'); // Can be null for "In Re:" cases
        const caseLink = interaction.options.getString('case_link');
        
        try {
            // Helper function to parse both mentions and regular usernames
            const parseUserInput = async (inputString) => {
                if (!inputString) return { userIds: [], usernames: [] };
                
                const userIds = [];
                const usernames = [];
                const tokens = inputString.split(/\s+/);
                
                for (const token of tokens) {
                    // Check if it's a mention
                    const mentionMatch = token.match(/<@!?(\d+)>/);
                    if (mentionMatch) {
                        userIds.push(mentionMatch[1]);
                    } else if (token.trim()) {
                        // Treat as username - try to find user by username
                        try {
                            const members = await interaction.guild.members.fetch({ query: token, limit: 100 });
                            const exactMatch = members.find(member => 
                                member.user.username.toLowerCase() === token.toLowerCase() ||
                                member.displayName.toLowerCase() === token.toLowerCase()
                            );
                            
                            if (exactMatch) {
                                userIds.push(exactMatch.id);
                            } else {
                                // If no Discord user found, store as plain username
                                usernames.push(token);
                            }
                        } catch (error) {
                            // If fetch fails, store as plain username
                            usernames.push(token);
                        }
                    }
                }
                
                return { userIds, usernames };
            };
            
            // Parse plaintiffs and defendants
            const plaintiffResult = await parseUserInput(plaintiffsString);
            const defendantResult = defendantsString ? await parseUserInput(defendantsString) : { userIds: [], usernames: [] };
            
            const plaintiffIds = plaintiffResult.userIds;
            const plaintiffUsernames = plaintiffResult.usernames;
            const defendantIds = defendantResult.userIds;
            const defendantUsernames = defendantResult.usernames;
            
            if (plaintiffIds.length === 0 && plaintiffUsernames.length === 0) {
                await interaction.editReply({
                    content: 'Please provide at least one plaintiff (using @mention or username).',
                    flags: 64
                });
                return;
            }
            
            // Defendants are now always optional
            
            // Start building permission overwrites
            const permissionOverwrites = [
                {
                    id: interaction.guild.id,
                    allow: [PermissionFlagsBits.ViewChannel],
                    deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
                },
                {
                    id: interaction.client.user.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
                },
                {
                    id: judge.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                }
            ];
            
            // Add clerk permissions if clerk is specified
            if (clerk) {
                permissionOverwrites.push({
                    id: clerk.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                });
            }
            
            // Add permissions for all plaintiffs
            for (const plaintiffId of plaintiffIds) {
                permissionOverwrites.push({
                    id: plaintiffId,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                });
            }
            
            // Add permissions for all defendants
            for (const defendantId of defendantIds) {
                permissionOverwrites.push({
                    id: defendantId,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                });
            }
            
            // Create the channel with proper permissions
            const channel = await interaction.guild.channels.create({
                name: caseCode.toLowerCase().replace(/\s+/g, '-'),
                type: ChannelType.GuildText,
                permissionOverwrites: permissionOverwrites
            });
            
            // Save case to database (store IDs and usernames as comma-separated strings)
            // For database, store both IDs and plain usernames
            const plaintiffsForDb = [...plaintiffIds, ...plaintiffUsernames].join(',');
            const defendantsForDb = [...defendantIds, ...defendantUsernames].join(',');
            
            await createCase(
                interaction.guildId,
                channel.id,
                caseCode,
                judge.id,
                clerk ? clerk.id : null,
                plaintiffsForDb,
                defendantsForDb,
                caseLink
            );
            
            // Create plaintiffs and defendants display strings
            const plaintiffMentions = plaintiffIds.map(id => `<@${id}>`);
            const allPlaintiffs = [...plaintiffMentions, ...plaintiffUsernames];
            const plaintiffsDisplay = allPlaintiffs.join(', ');
            
            const defendantMentions = defendantIds.map(id => `<@${id}>`);
            const allDefendants = [...defendantMentions, ...defendantUsernames];
            const defendantsDisplay = allDefendants.join(', ');
            
            // Build fields for the embed
            const embedFields = [
                { name: 'Judge', value: `<@${judge.id}>`, inline: true }
            ];
            
            if (clerk) {
                embedFields.push({ name: 'Clerk', value: `<@${clerk.id}>`, inline: true });
                embedFields.push({ name: '\u200B', value: '\u200B', inline: true });
            } else {
                embedFields.push({ name: 'Clerk', value: 'Not assigned', inline: true });
                embedFields.push({ name: '\u200B', value: '\u200B', inline: true });
            }
            
            embedFields.push(
                { name: allPlaintiffs.length > 1 ? 'Plaintiffs' : 'Plaintiff', value: plaintiffsDisplay, inline: true }
            );
            
            if (allDefendants.length > 0) {
                embedFields.push(
                    { name: allDefendants.length > 1 ? 'Defendants' : 'Defendant', value: defendantsDisplay, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }
                );
            } else {
                embedFields.push(
                    { name: 'Defendants', value: 'None', inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }
                );
            }
            
            // Create case information embed
            const caseEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`Case: ${caseCode}`)
                .setDescription('Discord Courtroom has been initialized\n\n⚖️ **NOTICE:** This channel is fully on the record and reflective of the actual court transcript. Please follow chamber rules.')
                .addFields(embedFields)
                .setTimestamp()
                .setFooter({ text: `Initialized by ${interaction.user.username}` });
            
            // Add URL if it's valid
            try {
                new URL(caseLink);
                caseEmbed.setURL(caseLink);
                caseEmbed.addFields({ name: 'Case Link', value: `[View Case](${caseLink})`, inline: false });
            } catch {
                // If not a valid URL, just add as plain text
                caseEmbed.addFields({ name: 'Case Link', value: caseLink, inline: false });
            }
            
            // Send the embed to the new channel
            await channel.send({ embeds: [caseEmbed] });
            
            // Reply to the interaction
            await interaction.editReply({
                content: `Case ${caseCode} has been initialized successfully! Channel: ${channel}`,
                ephemeral: false
            });
            
        } catch (error) {
            console.error('Error initializing case:', error);
            await interaction.editReply({ 
                content: 'An error occurred while initializing the case.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'transcript') {
        await interaction.deferReply();
        
        try {
            const channel = interaction.channel;
            const messages = [];
            let lastMessageId;
            
            // Fetch all messages from the channel
            while (true) {
                const options = { limit: 100 };
                if (lastMessageId) {
                    options.before = lastMessageId;
                }
                
                const fetchedMessages = await channel.messages.fetch(options);
                if (fetchedMessages.size === 0) break;
                
                messages.push(...fetchedMessages.values());
                lastMessageId = fetchedMessages.last().id;
            }
            
            // Sort messages by timestamp (oldest first)
            messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            
            // Generate HTML
            const html = generateTranscriptHTML(channel, messages);
            
            // Create temporary file
            const filename = `transcript-${channel.name}-${Date.now()}.html`;
            const filepath = `/tmp/${filename}`;
            await fs.writeFile(filepath, html);
            
            // Create attachment
            const attachment = new AttachmentBuilder(filepath, { name: filename });
            
            // Send the file
            await interaction.editReply({
                content: `Transcript generated for ${channel.name}`,
                files: [attachment]
            });
            
            // Clean up temp file
            await fs.unlink(filepath);
            
        } catch (error) {
            console.error('Error generating transcript:', error);
            await interaction.editReply({ 
                content: 'An error occurred while generating the transcript.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'add') {
        const user = interaction.options.getUser('user');
        const channel = interaction.channel;
        
        try {
            await channel.permissionOverwrites.edit(user.id, {
                ViewChannel: true,
                SendMessages: true
            });
            
            await interaction.reply({
                content: `Successfully added ${user} to this channel.`,
                ephemeral: false
            });
        } catch (error) {
            console.error('Error adding user to channel:', error);
            await interaction.reply({ 
                content: 'An error occurred while adding the user to the channel.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'remove') {
        const user = interaction.options.getUser('user');
        const channel = interaction.channel;
        
        try {
            await channel.permissionOverwrites.delete(user.id);
            
            await interaction.reply({
                content: `Successfully removed ${user} from this channel.`,
                ephemeral: false
            });
        } catch (error) {
            console.error('Error removing user from channel:', error);
            await interaction.reply({ 
                content: 'An error occurred while removing the user from the channel.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'seal') {
        const channel = interaction.channel;
        
        try {
            // Update @everyone permissions to deny viewing
            await channel.permissionOverwrites.edit(interaction.guild.id, {
                ViewChannel: false
            });
            
            await interaction.reply({
                content: 'Channel has been sealed. Only parties with explicit permissions can view this channel.',
                ephemeral: false
            });
        } catch (error) {
            console.error('Error sealing channel:', error);
            await interaction.reply({ 
                content: 'An error occurred while sealing the channel.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'unseal') {
        const channel = interaction.channel;
        
        try {
            // Update @everyone permissions to allow viewing but not sending
            await channel.permissionOverwrites.edit(interaction.guild.id, {
                ViewChannel: true,
                SendMessages: false,
                AddReactions: false
            });
            
            await interaction.reply({
                content: 'Channel has been unsealed. Everyone can now view this channel.',
                ephemeral: false
            });
        } catch (error) {
            console.error('Error unsealing channel:', error);
            await interaction.reply({ 
                content: 'An error occurred while unsealing the channel.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'gag') {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        const channel = interaction.channel;
        
        try {
            // Update user permissions to deny sending messages
            await channel.permissionOverwrites.edit(user.id, {
                SendMessages: false,
                AddReactions: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false
            });
            
            // Create gag order embed
            const gagEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚖️ GAG ORDER ISSUED')
                .setDescription(`A gag order has been issued in this case.`)
                .addFields(
                    { name: 'Party', value: `${user}`, inline: true },
                    { name: 'Issued By', value: `${interaction.user}`, inline: true },
                    { name: 'Reason', value: reason, inline: false },
                    { name: 'Effect', value: 'The named party is prohibited from sending messages in this channel until the gag order is lifted.', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'This order is effective immediately' });
            
            await interaction.reply({ embeds: [gagEmbed] });
            
            // Save gag order to database
            await createGagOrder(
                interaction.guildId,
                channel.id,
                user.id,
                interaction.user.id,
                reason
            );
            
        } catch (error) {
            console.error('Error issuing gag order:', error);
            await interaction.reply({ 
                content: 'An error occurred while issuing the gag order.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'ungag') {
        const user = interaction.options.getUser('user');
        const channel = interaction.channel;
        
        try {
            // Restore user permissions
            await channel.permissionOverwrites.edit(user.id, {
                SendMessages: true,
                AddReactions: null,
                CreatePublicThreads: null,
                CreatePrivateThreads: null,
                SendMessagesInThreads: null
            });
            
            // Create ungag embed
            const ungagEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('⚖️ GAG ORDER LIFTED')
                .setDescription(`The gag order has been lifted.`)
                .addFields(
                    { name: 'Party', value: `${user}`, inline: true },
                    { name: 'Lifted By', value: `${interaction.user}`, inline: true },
                    { name: 'Effect', value: 'The named party may now participate in this channel.', inline: false }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [ungagEmbed] });
            
            // Update gag order status in database
            await updateGagOrderStatus(interaction.guildId, channel.id, user.id);
            
        } catch (error) {
            console.error('Error lifting gag order:', error);
            await interaction.reply({ 
                content: 'An error occurred while lifting the gag order.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'close') {
        await interaction.deferReply();
        
        const channel = interaction.channel;
        const ARCHIVE_CATEGORY_ID = '1391054003252756642';
        
        try {
            // First, generate the transcript
            const messages = [];
            let lastMessageId;
            
            // Fetch all messages from the channel
            while (true) {
                const options = { limit: 100 };
                if (lastMessageId) {
                    options.before = lastMessageId;
                }
                
                const fetchedMessages = await channel.messages.fetch(options);
                if (fetchedMessages.size === 0) break;
                
                messages.push(...fetchedMessages.values());
                lastMessageId = fetchedMessages.last().id;
            }
            
            // Sort messages by timestamp (oldest first)
            messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            
            // Generate HTML
            const html = generateTranscriptHTML(channel, messages);
            
            // Create temporary file
            const filename = `transcript-${channel.name}-${Date.now()}.html`;
            const filepath = `/tmp/${filename}`;
            await fs.writeFile(filepath, html);
            
            // Create attachment
            const attachment = new AttachmentBuilder(filepath, { name: filename });
            
            // Send the transcript
            await interaction.editReply({
                content: `Case closed. Final transcript generated for ${channel.name}`,
                files: [attachment]
            });
            
            // Clean up temp file
            await fs.unlink(filepath);
            
            // Move channel to archive category without syncing permissions
            await channel.setParent(ARCHIVE_CATEGORY_ID, { lockPermissions: false });
            
            // Remove all existing permission overwrites and set new ones
            await channel.permissionOverwrites.set([
                {
                    id: interaction.guild.id,
                    allow: [PermissionFlagsBits.ViewChannel],
                    deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
                },
                {
                    id: interaction.client.user.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                }
            ]);
            
            // Send closing message
            const closeEmbed = new EmbedBuilder()
                .setColor(0x808080)
                .setTitle('⚖️ CASE CLOSED')
                .setDescription('This case has been closed and archived.')
                .addFields(
                    { name: 'Status', value: 'Closed', inline: true },
                    { name: 'Closed By', value: `${interaction.user}`, inline: true },
                    { name: 'Closed At', value: new Date().toLocaleString(), inline: true }
                )
                .setFooter({ text: 'This channel is now read-only and has been archived.' })
                .setTimestamp();
            
            await channel.send({ embeds: [closeEmbed] });
            
            // Update case status in database
            await updateCaseStatus(interaction.guildId, channel.id, 'closed');
            
        } catch (error) {
            console.error('Error closing case:', error);
            await interaction.editReply({ 
                content: 'An error occurred while closing the case.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'fix') {
        await interaction.deferReply();
        
        const channel = interaction.channel;
        const ARCHIVE_CATEGORY_ID = '1391054003252756642';
        
        try {
            // Check if channel is in archive category
            if (channel.parentId !== ARCHIVE_CATEGORY_ID) {
                await interaction.editReply({
                    content: 'This command can only be used in archived case channels.',
                    flags: 64
                });
                return;
            }
            
            // Move channel back to main category (no parent)
            await channel.setParent(null, { lockPermissions: false });
            
            // Get all parties from the database
            const caseData = await getCaseByChannel(interaction.guildId, channel.id);
            if (!caseData) {
                await interaction.editReply({
                    content: 'Case data not found in database.',
                    flags: 64
                });
                return;
            }
            
            // Reset permissions to allow everyone to send messages
            const permissionOverwrites = [
                {
                    id: interaction.guild.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
                },
                {
                    id: interaction.client.user.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]
                }
            ];
            
            // Add judge permissions
            if (caseData.judge_id) {
                permissionOverwrites.push({
                    id: caseData.judge_id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]
                });
            }
            
            // Add clerk permissions
            if (caseData.clerk_id) {
                permissionOverwrites.push({
                    id: caseData.clerk_id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]
                });
            }
            
            // Add plaintiff permissions
            if (caseData.plaintiff_ids) {
                const plaintiffIds = caseData.plaintiff_ids.split(',').filter(id => id && !id.includes('#'));
                for (const plaintiffId of plaintiffIds) {
                    permissionOverwrites.push({
                        id: plaintiffId,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                    });
                }
            }
            
            // Add defendant permissions
            if (caseData.defendant_ids) {
                const defendantIds = caseData.defendant_ids.split(',').filter(id => id && !id.includes('#'));
                for (const defendantId of defendantIds) {
                    permissionOverwrites.push({
                        id: defendantId,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                    });
                }
            }
            
            // Apply all permission overwrites
            await channel.permissionOverwrites.set(permissionOverwrites);
            
            // Update case status in database
            await updateCaseStatus(interaction.guildId, channel.id, 'active');
            
            // Send reopening message
            const reopenEmbed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('⚖️ CASE REOPENED')
                .setDescription('This case has been reopened and is now active.')
                .addFields(
                    { name: 'Status', value: 'Active', inline: true },
                    { name: 'Reopened By', value: `${interaction.user}`, inline: true },
                    { name: 'Reopened At', value: new Date().toLocaleString(), inline: true }
                )
                .setFooter({ text: 'This channel is now active and all parties can send messages.' })
                .setTimestamp();
            
            await channel.send({ embeds: [reopenEmbed] });
            
            await interaction.editReply({
                content: `Case ${channel.name} has been successfully reopened.`
            });
            
        } catch (error) {
            console.error('Error reopening case:', error);
            await interaction.editReply({ 
                content: 'An error occurred while reopening the case.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'reassign') {
        await interaction.deferReply();
        
        const newJudge = interaction.options.getUser('new_judge');
        const channel = interaction.channel;
        
        try {
            // Get the case data
            const caseData = await getCaseByChannel(interaction.guildId, channel.id);
            if (!caseData) {
                await interaction.editReply({
                    content: 'This channel is not associated with a case.',
                    flags: 64
                });
                return;
            }
            
            // Get the old judge info for the announcement
            const oldJudge = await interaction.guild.members.fetch(caseData.judge_id).catch(() => null);
            
            // Update the judge in the database
            await reassignCase(interaction.guildId, channel.id, newJudge.id);
            
            // Update channel permissions - remove old judge permissions
            if (oldJudge) {
                await channel.permissionOverwrites.delete(caseData.judge_id).catch(() => {});
            }
            
            // Add new judge permissions
            await channel.permissionOverwrites.create(newJudge.id, {
                ViewChannel: true,
                SendMessages: true,
                ManageMessages: true
            });
            
            // Create reassignment embed
            const reassignEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('⚖️ CASE REASSIGNMENT')
                .setDescription('This case has been transferred to a new judge.')
                .addFields(
                    { name: 'Previous Judge', value: oldJudge ? `${oldJudge}` : 'Unknown', inline: true },
                    { name: 'New Judge', value: `${newJudge}`, inline: true },
                    { name: 'Reassigned By', value: `${interaction.user}`, inline: true },
                    { name: 'Case Code', value: caseData.case_code, inline: true },
                    { name: 'Reassigned At', value: new Date().toLocaleString(), inline: false }
                )
                .setFooter({ text: 'All parties should direct future communications to the new judge.' })
                .setTimestamp();
            
            await channel.send({ embeds: [reassignEmbed] });
            
            await interaction.editReply({
                content: `Case ${caseData.case_code} has been successfully reassigned from ${oldJudge ? oldJudge.user.username : 'previous judge'} to ${newJudge.username}.`
            });
            
        } catch (error) {
            console.error('Error reassigning case:', error);
            await interaction.editReply({ 
                content: 'An error occurred while reassigning the case.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'finalruling') {
        const channel = interaction.channel;
        
        try {
            // Create final ruling embed
            const deadline = new Date();
            deadline.setHours(deadline.getHours() + 24);
            
            const finalRulingEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚖️ FINAL RULING')
                .setDescription('**A final ruling has been entered into the record.**\n\nPlease refer to the Ridgeway Unified Court System Website.')
                .addFields(
                    { name: '⚠️ IMPORTANT NOTICE', value: 'You must file a **Notice of Appeal** within **24 hours** should you intend to appeal.', inline: false },
                    { name: '📋 Appeal Information', value: 'A Notice of Appeal does not constitute a deadline of when you must file your appeal, which is **30 days**.', inline: false },
                    { name: '❌ WARNING', value: 'Failing to file a Notice of Appeal will result in you losing access to case channels.', inline: false },
                    { name: '⏰ Notice Deadline', value: `${deadline.toLocaleString()}`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'This ruling is effective immediately' });
            
            await interaction.reply({ embeds: [finalRulingEmbed] });
            
            // Get case information from database
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (caseInfo) {
                // Save appeal deadline to database
                await createAppealDeadline(
                    interaction.guildId,
                    channel.id,
                    caseInfo.plaintiff_ids,
                    caseInfo.defendant_ids,
                    deadline
                );
            }
            
        } catch (error) {
            console.error('Error issuing final ruling:', error);
            await interaction.reply({ 
                content: 'An error occurred while issuing the final ruling.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'appealnotice') {
        const channel = interaction.channel;
        const userId = interaction.user.id;
        
        try {
            // First check if we can proceed - do all checks before any replies
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.reply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            const appealDeadline = await getActiveAppealDeadline(interaction.guildId, channel.id);
            
            if (!appealDeadline) {
                await interaction.reply({
                    content: 'No final ruling has been issued in this case, or the appeal period has already expired.',
                    flags: 64
                });
                return;
            }
            
            if (appealDeadline.appeal_filed) {
                await interaction.reply({
                    content: 'A notice of appeal has already been filed in this case.',
                    flags: 64
                });
                return;
            }
            
            // All checks passed, now defer for the actual work
            await interaction.deferReply();
            
            // File the appeal notice
            await fileAppealNotice(interaction.guildId, channel.id, userId);
            
            // Determine party name (check if they're plaintiff, defendant, or other party)
            let partyType = 'Party';
            const plaintiffIds = caseInfo.plaintiff_ids ? caseInfo.plaintiff_ids.split(',').map(id => id.trim()) : [];
            const defendantIds = caseInfo.defendant_ids ? caseInfo.defendant_ids.split(',').map(id => id.trim()) : [];
            
            if (plaintiffIds.includes(userId)) {
                partyType = 'Plaintiff';
            } else if (defendantIds.includes(userId)) {
                partyType = 'Defendant';
            }
            
            // Create appeal notice embed
            const appealNoticeEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('📋 NOTICE OF APPEAL')
                .setDescription(`${interaction.user} intends to appeal the final order in the matter of **${caseInfo.case_code}** to the Supreme Court of Ridgeway.`)
                .addFields(
                    { name: 'Filed By', value: `${interaction.user} (${partyType})`, inline: true },
                    { name: 'Filed At', value: new Date().toLocaleString(), inline: true },
                    { name: 'Case', value: caseInfo.case_code, inline: true },
                    { name: '📌 Important', value: 'The Clerk is instructed to maintain channel access for all parties until the Supreme Court of Ridgeway delivers a response.', inline: false },
                    { name: '⏰ Appeal Deadline', value: 'The appellant has 30 days from the date of the final ruling to file their formal appeal with the Supreme Court.', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Channel access will be maintained for all parties' });
            
            await interaction.editReply({ embeds: [appealNoticeEmbed] });
            
        } catch (error) {
            console.error('Error filing appeal notice:', error);
            
            // Handle errors based on interaction state
            try {
                if (interaction.deferred) {
                    await interaction.editReply({ 
                        content: 'An error occurred while filing the appeal notice.' 
                    });
                } else if (!interaction.replied) {
                    await interaction.reply({ 
                        content: 'An error occurred while filing the appeal notice.', 
                        flags: 64
                    });
                }
            } catch (replyError) {
                console.error('Error sending error message:', replyError);
            }
        }
    }
    
    if (interaction.commandName === 'certiorari') {
        await interaction.deferReply();
        
        const channel = interaction.channel;
        const userId = interaction.user.id;
        const writFiling = interaction.options.getString('writ_filing');
        
        try {
            // Get case information (already checked permissions at top level)
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.editReply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Check if an appeal notice was filed
            const appealDeadline = await getActiveAppealDeadline(interaction.guildId, channel.id);
            if (!appealDeadline || !appealDeadline.appeal_filed) {
                await interaction.editReply({
                    content: 'You must file a notice of appeal before filing a writ of certiorari.',
                    flags: 64
                });
                return;
            }
            
            // Validate Google Drive link
            if (!writFiling.includes('drive.google.com') && !writFiling.includes('docs.google.com')) {
                await interaction.editReply({
                    content: 'Please provide a valid Google Drive link for your writ filing.',
                    flags: 64
                });
                return;
            }
            
            // First, generate the transcript for the case
            const messages = [];
            let lastMessageId;
            
            // Fetch all messages from the channel
            while (true) {
                const options = { limit: 100 };
                if (lastMessageId) {
                    options.before = lastMessageId;
                }
                
                const fetchedMessages = await channel.messages.fetch(options);
                if (fetchedMessages.size === 0) break;
                
                messages.push(...fetchedMessages.values());
                lastMessageId = fetchedMessages.last().id;
            }
            
            // Sort messages by timestamp (oldest first)
            messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            
            // Generate HTML transcript
            const html = generateTranscriptHTML(channel, messages);
            
            // Create temporary file for transcript
            const filename = `appeal-transcript-${caseInfo.case_code}-${Date.now()}.html`;
            const filepath = `/tmp/${filename}`;
            await fs.writeFile(filepath, html);
            
            // Create attachment for transcript
            const transcriptAttachment = new AttachmentBuilder(filepath, { name: filename });
            
            // Move channel to appeals category
            const APPEALS_CATEGORY_ID = '1391058207102865448';
            await channel.setParent(APPEALS_CATEGORY_ID);
            
            // Lock channel to only judge and clerk
            await channel.permissionOverwrites.set([
                {
                    id: interaction.guild.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: interaction.client.user.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                },
                {
                    id: caseInfo.judge_id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                },
                {
                    id: caseInfo.clerk_id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                }
            ]);
            
            // Create embed for the Supreme Court
            let partyType = 'Party';
            if (userId === caseInfo.plaintiff_id) {
                partyType = 'Plaintiff';
            } else if (userId === caseInfo.defendant_id) {
                partyType = 'Defendant';
            }
            const scorEmbed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('⚖️ WRIT OF CERTIORARI FILED')
                .setDescription(`A writ of certiorari has been filed for case **${caseInfo.case_code}**`)
                .addFields(
                    { name: 'Case', value: caseInfo.case_code, inline: true },
                    { name: 'Filed By', value: `<@${userId}> (${partyType})`, inline: true },
                    { name: 'Filed At', value: new Date().toLocaleString(), inline: true },
                    { name: 'Judge', value: `<@${caseInfo.judge_id}>`, inline: true },
                    { name: 'Clerk', value: `<@${caseInfo.clerk_id}>`, inline: true },
                    { name: 'Original Court', value: `${interaction.guild.name}`, inline: true },
                    { name: 'Plaintiff', value: `<@${caseInfo.plaintiff_id}>`, inline: true },
                    { name: 'Defendant', value: `<@${caseInfo.defendant_id}>`, inline: true },
                    { name: 'Case Link', value: caseInfo.case_link || 'Not provided', inline: true },
                    { name: 'Writ Filing', value: `[View Writ](${writFiling})`, inline: false }
                )
                .setTimestamp();
            
            // Send to Supreme Court server
            const SCOR_SERVER_ID = '1361418953460547625';
            const SCOR_CHANNEL_ID = '1391058529510494369';
            
            try {
                const scorGuild = await client.guilds.fetch(SCOR_SERVER_ID);
                const scorChannel = await scorGuild.channels.fetch(SCOR_CHANNEL_ID);
                
                const scorMessage = await scorChannel.send({
                    embeds: [scorEmbed],
                    files: [transcriptAttachment]
                });
                
                // Save appeal filing to database
                await createAppealFiling(
                    interaction.guildId,
                    channel.id,
                    caseInfo.case_code,
                    userId,
                    writFiling,
                    scorMessage.id
                );
                
            } catch (scorError) {
                console.error('Error sending to SCOR:', scorError);
                // Continue with local confirmation even if SCOR send fails
            }
            
            // Clean up temp file
            await fs.unlink(filepath);
            
            // Create local confirmation embed
            const confirmEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ Writ of Certiorari Filed')
                .setDescription('Your writ of certiorari has been successfully filed.')
                .addFields(
                    { name: 'Status', value: 'The case has been moved to the appeals category and locked to judge and clerk only.', inline: false },
                    { name: 'Next Steps', value: 'The Supreme Court of Ridgeway will review your filing and respond accordingly.', inline: false }
                )
                .setTimestamp();
            
            await interaction.editReply({ embeds: [confirmEmbed] });
            
            // Post notification in the channel
            const notificationEmbed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('📋 CASE ON APPEAL')
                .setDescription(`This case is now pending before the Supreme Court of Ridgeway.`)
                .addFields(
                    { name: 'Appellant', value: `${interaction.user} (${partyType})`, inline: true },
                    { name: 'Status', value: 'Under Review', inline: true },
                    { name: 'Access', value: 'This channel is now restricted to the Judge and Clerk only.', inline: false }
                )
                .setTimestamp();
            
            await channel.send({ embeds: [notificationEmbed] });
            
        } catch (error) {
            console.error('Error filing certiorari:', error);
            await interaction.editReply({ 
                content: 'An error occurred while filing the writ of certiorari.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'financialdisclosure') {
        const channel = interaction.channel;
        const userId = interaction.user.id;
        
        try {
            // Get case information to verify this is a case channel
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.reply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Defer reply as we'll be doing calculations and generating files
            await interaction.deferReply();
            
            // Get all the financial information
            const bankBalance = interaction.options.getNumber('bank_balance');
            const cashBalance = interaction.options.getNumber('cash_balance');
            const vehiclesInput = interaction.options.getString('vehicles');
            const debts = interaction.options.getNumber('debts');
            const ownsHome = interaction.options.getBoolean('own_home');
            
            // Parse vehicle values from the input string
            let vehicleValue = 0;
            const vehicleMatches = vehiclesInput.match(/\$?(\d+(?:,\d{3})*(?:\.\d{2})?)/g);
            if (vehicleMatches) {
                vehicleMatches.forEach(match => {
                    const value = parseFloat(match.replace(/[$,]/g, ''));
                    vehicleValue += value;
                });
            }
            
            // Calculate net worth
            const totalAssets = bankBalance + cashBalance + vehicleValue;
            const netWorth = totalAssets - debts;
            
            // Determine eligibility
            let eligibility;
            let embedColor;
            let eligibilityText;
            
            if (netWorth > 20000) {
                eligibility = 'ineligible';
                embedColor = 0xFF0000; // Red
                eligibilityText = 'Does NOT qualify for court-appointed counsel';
            } else if (netWorth > 10000) {
                eligibility = 'discretionary';
                embedColor = 0xFFA500; // Orange
                eligibilityText = 'Eligibility subject to judicial discretion';
            } else {
                eligibility = 'eligible';
                embedColor = 0x00FF00; // Green
                eligibilityText = 'QUALIFIES for court-appointed counsel';
            }
            
            // Save to database
            await createFinancialDisclosure(
                interaction.guildId,
                channel.id,
                userId,
                bankBalance,
                cashBalance,
                vehiclesInput,
                vehicleValue,
                debts,
                ownsHome,
                netWorth,
                eligibility
            );
            
            // Create the official disclosure embed
            const disclosureEmbed = new EmbedBuilder()
                .setColor(embedColor)
                .setTitle('⚖️ FINANCIAL DISCLOSURE AFFIDAVIT')
                .setDescription(`Under penalty of perjury, ${interaction.user} has attested to the following financial disclosures:`)
                .addFields(
                    { name: 'Bank Account Balance', value: `$${bankBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
                    { name: 'Cash on Hand', value: `$${cashBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
                    { name: 'Vehicle(s) Value', value: `$${vehicleValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
                    { name: 'Vehicle Details', value: vehiclesInput || 'None', inline: false },
                    { name: 'Outstanding Debts', value: `$${debts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
                    { name: 'Homeownership', value: ownsHome ? 'Owns Residence' : 'Rents/No Home Ownership', inline: true },
                    { name: '\u200B', value: '\u200B', inline: true },
                    { name: '📊 FINANCIAL SUMMARY', value: '\u200B', inline: false },
                    { name: 'Total Assets', value: `$${totalAssets.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
                    { name: 'Total Debts', value: `$${debts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
                    { name: 'Net Worth', value: `$${netWorth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, inline: true },
                    { name: '⚖️ ELIGIBILITY DETERMINATION', value: eligibilityText, inline: false }
                )
                .setFooter({ text: `Case: ${caseInfo.case_code} | Filed: ${new Date().toLocaleString()}` })
                .setTimestamp();
            
            // Generate HTML receipt
            const receiptHtml = generateFinancialDisclosureHTML(
                interaction.user.username,
                caseInfo.case_code,
                {
                    bankBalance,
                    cashBalance,
                    vehiclesInput,
                    vehicleValue,
                    debts,
                    ownsHome,
                    totalAssets,
                    netWorth,
                    eligibility,
                    eligibilityText
                }
            );
            
            // Create temporary file for receipt
            const filename = `financial-disclosure-${caseInfo.case_code}-${userId}-${Date.now()}.html`;
            const filepath = `/tmp/${filename}`;
            await fs.writeFile(filepath, receiptHtml);
            
            // Create attachment
            const receiptAttachment = new AttachmentBuilder(filepath, { name: filename });
            
            // Send the response
            await interaction.editReply({
                embeds: [disclosureEmbed],
                files: [receiptAttachment]
            });
            
            // Clean up temp file
            await fs.unlink(filepath);
            
        } catch (error) {
            console.error('Error processing financial disclosure:', error);
            
            try {
                if (interaction.deferred) {
                    await interaction.editReply({ 
                        content: 'An error occurred while processing your financial disclosure.' 
                    });
                } else if (!interaction.replied) {
                    await interaction.reply({ 
                        content: 'An error occurred while processing your financial disclosure.', 
                        flags: 64
                    });
                }
            } catch (replyError) {
                console.error('Error sending error message:', replyError);
            }
        }
    }
    
    if (interaction.commandName === 'erpo') {
        await interaction.deferReply();
        
        const targetUser = interaction.options.getUser('user');
        const channel = interaction.channel;
        
        try {
            // Get case information to extract case code
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.editReply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Create 12-hour deadline
            const deadline = new Date();
            deadline.setHours(deadline.getHours() + 12);
            
            // Create ERPO order in database
            const erpoOrder = await createERPOOrder(
                interaction.guildId,
                channel.id,
                caseInfo.case_code,
                targetUser.id,
                interaction.user.id,
                deadline
            );
            
            // Generate PDF receipt
            const pdfBuffer = await generateERPOPDF(erpoOrder, targetUser, interaction.user, caseInfo.case_code, deadline);
            
            // Create attachment
            const filename = `erpo-order-${caseInfo.case_code}-${Date.now()}.pdf`;
            const attachment = new AttachmentBuilder(pdfBuffer, { name: filename });
            
            // Create ERPO embed
            const erpoEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('🚨 EXTREME RISK PROTECTION ORDER')
                .setDescription(`An Extreme Risk Protection Order has been issued against ${targetUser}.`)
                .addFields(
                    { name: 'Subject', value: `${targetUser}`, inline: true },
                    { name: 'Issued By', value: `${interaction.user}`, inline: true },
                    { name: 'Case', value: caseInfo.case_code, inline: true },
                    { name: '⚖️ ORDER', value: `${targetUser} shall immediately surrender all firearms, ammunition, and firearms accessories in their possession, custody, or control.`, inline: false },
                    { name: '⏰ DEADLINE', value: `${targetUser} has 12 hours from service of this order to surrender all firearms to Ridgeway County Sheriff's Office or a Bona Fide Peace Officer appointed by the court.`, inline: false },
                    { name: '📋 REQUIREMENT', value: 'A Firearms Relinquishment Form must be filled out upon surrender.', inline: false },
                    { name: 'Deadline Time', value: deadline.toLocaleString(), inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'This is a lawful order of the court' });
            
            // Send the response with PDF
            await interaction.editReply({
                content: `${targetUser}`,
                embeds: [erpoEmbed],
                files: [attachment]
            });
            
            // Send follow-up message mentioning the target user
            await channel.send({
                content: `⚠️ **LEGAL NOTICE** ⚠️\n${targetUser}, you have been served with an Extreme Risk Protection Order. Please review the order above immediately. You have 12 hours to comply.`
            });
            
        } catch (error) {
            console.error('Error issuing ERPO:', error);
            await interaction.editReply({ 
                content: 'An error occurred while issuing the ERPO.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'lifterpo') {
        await interaction.deferReply();
        
        const targetUser = interaction.options.getUser('user');
        const channel = interaction.channel;
        
        try {
            // Get case information to extract case code
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.editReply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Check if user has permission (must be judge or clerk)
            if (interaction.user.id !== caseInfo.judge_id && interaction.user.id !== caseInfo.clerk_id) {
                await interaction.editReply({
                    content: 'Only the assigned judge or clerk can lift an ERPO.',
                    flags: 64
                });
                return;
            }
            
            // Find active ERPO for the user
            const activeERPO = await getActiveERPOByUser(interaction.guildId, channel.id, targetUser.id);
            
            if (!activeERPO) {
                await interaction.editReply({
                    content: `No active ERPO found for ${targetUser} in this case.`,
                    flags: 64
                });
                return;
            }
            
            // Lift the ERPO
            await liftERPO(activeERPO.id);
            
            // Create success embed
            const liftEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ ERPO Lifted')
                .setDescription(`The Extreme Risk Protection Order against ${targetUser} has been lifted.`)
                .addFields(
                    { name: 'Subject', value: `${targetUser}`, inline: true },
                    { name: 'Lifted By', value: `${interaction.user}`, inline: true },
                    { name: 'Case', value: caseInfo.case_code, inline: true },
                    { name: 'Original Order Date', value: new Date(activeERPO.created_at).toLocaleString(), inline: false },
                    { name: 'Status', value: '✅ The ERPO has been successfully lifted and removed from the system.', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Official court order lifting' });
            
            await interaction.editReply({ embeds: [liftEmbed] });
            
            // Notify the affected user
            try {
                const dmEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('✅ ERPO Lifted')
                    .setDescription('An Extreme Risk Protection Order against you has been lifted.')
                    .addFields(
                        { name: 'Case', value: caseInfo.case_code, inline: true },
                        { name: 'Lifted By', value: `Judge/Clerk`, inline: true },
                        { name: 'Effect', value: 'The restrictions imposed by the ERPO are no longer in effect.', inline: false }
                    )
                    .setTimestamp();
                
                await targetUser.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                // User has DMs disabled or blocked the bot
                console.error(`Failed to DM user ${targetUser.id} about lifted ERPO:`, dmError.message);
            }
            
        } catch (error) {
            console.error('Error lifting ERPO:', error);
            await interaction.editReply({ 
                content: 'An error occurred while lifting the ERPO.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'firearmsrelinquishment') {
        const channel = interaction.channel;
        const userId = interaction.user.id;
        
        try {
            // Get case information to verify this is a case channel
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.reply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Defer reply as we'll be generating PDFs
            await interaction.deferReply();
            
            // Get all the relinquishment information
            const workFirearms = interaction.options.getBoolean('work_firearms');
            const firearmsOwned = interaction.options.getString('firearms_owned');
            const ammunitionOwned = interaction.options.getString('ammunition_owned');
            const surrenderedAll = interaction.options.getBoolean('surrendered_all');
            const understandProhibition = interaction.options.getBoolean('understand_prohibition');
            
            // Check if emergency notice is needed (if either of last two questions is false)
            const emergencyNotice = !surrenderedAll || !understandProhibition;
            
            // Save to database
            await createFirearmsRelinquishment(
                interaction.guildId,
                channel.id,
                caseInfo.case_code,
                userId,
                workFirearms,
                firearmsOwned,
                ammunitionOwned,
                surrenderedAll,
                understandProhibition,
                emergencyNotice
            );
            
            // Determine embed color based on compliance
            const embedColor = emergencyNotice ? 0xFF0000 : 0x00FF00; // Red if non-compliant, green if compliant
            
            // Create the relinquishment embed
            const relinquishmentEmbed = new EmbedBuilder()
                .setColor(embedColor)
                .setTitle('🔫 FIREARMS RELINQUISHMENT FORM')
                .setDescription(`Under penalty of perjury, ${interaction.user} has submitted the following firearms relinquishment disclosure:`)
                .addFields(
                    { name: 'Work-Related Firearms', value: workFirearms ? 'Yes' : 'No', inline: true },
                    { name: 'All Firearms Surrendered', value: surrenderedAll ? '✅ Yes' : '❌ No', inline: true },
                    { name: 'Understands License Prohibition', value: understandProhibition ? '✅ Yes' : '❌ No', inline: true },
                    { name: 'Firearms Owned', value: firearmsOwned || 'None declared', inline: false },
                    { name: 'Ammunition Owned', value: ammunitionOwned || 'None declared', inline: false }
                );
            
            // Add emergency notice if needed
            if (emergencyNotice) {
                relinquishmentEmbed.addFields(
                    { name: '🚨 EMERGENCY NOTICE TO COURT', value: 'The respondent has indicated either:\n• They have NOT surrendered all firearms to authorities\n• They do NOT understand the prohibition on acquiring firearms licenses\n\n**IMMEDIATE JUDICIAL REVIEW REQUIRED**', inline: false }
                );
            } else {
                relinquishmentEmbed.addFields(
                    { name: '✅ COMPLIANCE STATUS', value: 'Respondent has confirmed full compliance with firearms surrender and understanding of license prohibitions.', inline: false }
                );
            }
            
            relinquishmentEmbed.addFields(
                { name: '⚖️ LEGAL NOTICE', value: 'These firearms are seized pending resolution of the active court matter. Any false statements made herein may result in criminal prosecution for perjury.', inline: false }
            );
            
            // Add employment protection notice if applicable
            if (workFirearms) {
                relinquishmentEmbed.addFields(
                    { name: '💼 EMPLOYMENT PROTECTION', value: 'An Employment Protection Order has been issued to protect your work status. See attached minute order.', inline: false }
                );
            }
            
            relinquishmentEmbed
            .setFooter({ text: `Case: ${caseInfo.case_code} | Filed: ${new Date().toLocaleString()}` })
            .setTimestamp();
            
            // Generate PDF minute order
            const pdfBuffer = await generateFirearmsRelinquishmentPDF(
                interaction.user,
                caseInfo.case_code,
                {
                    workFirearms,
                    firearmsOwned,
                    ammunitionOwned,
                    surrenderedAll,
                    understandProhibition,
                    emergencyNotice
                }
            );
            
            // Create attachment
            const filename = `firearms-relinquishment-${caseInfo.case_code}-${userId}-${Date.now()}.pdf`;
            const attachment = new AttachmentBuilder(pdfBuffer, { name: filename });
            
            // If work firearms, also generate employment protection order
            let attachments = [attachment];
            if (workFirearms) {
                const employmentPdfBuffer = await generateEmploymentProtectionOrder(
                    interaction.user,
                    caseInfo.case_code
                );
                const employmentFilename = `employment-protection-order-${caseInfo.case_code}-${userId}-${Date.now()}.pdf`;
                const employmentAttachment = new AttachmentBuilder(employmentPdfBuffer, { name: employmentFilename });
                attachments.push(employmentAttachment);
            }
            
            // Send the response
            await interaction.editReply({
                embeds: [relinquishmentEmbed],
                files: attachments
            });
            
            // If emergency notice, send additional alert
            if (emergencyNotice) {
                const alertEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚨 URGENT: NON-COMPLIANCE ALERT')
                    .setDescription('IMMEDIATE ATTENTION REQUIRED')
                    .addFields(
                        { name: 'Case', value: caseInfo.case_code, inline: true },
                        { name: 'Party', value: `${interaction.user}`, inline: true },
                        { name: 'Issue', value: 'Non-compliance with firearms relinquishment order', inline: false },
                        { name: 'Details', value: `Surrendered All: ${surrenderedAll ? 'Yes' : '**NO**'}\nUnderstands Prohibition: ${understandProhibition ? 'Yes' : '**NO**'}`, inline: false }
                    )
                    .setTimestamp();
                
                await channel.send({
                    content: `<@${caseInfo.judge_id}> <@${caseInfo.clerk_id}>`,
                    embeds: [alertEmbed]
                });
            }
            
        } catch (error) {
            console.error('Error processing firearms relinquishment:', error);
            
            try {
                if (interaction.deferred) {
                    await interaction.editReply({ 
                        content: 'An error occurred while processing your firearms relinquishment form.' 
                    });
                } else if (!interaction.replied) {
                    await interaction.reply({ 
                        content: 'An error occurred while processing your firearms relinquishment form.', 
                        flags: 64
                    });
                }
            } catch (replyError) {
                console.error('Error sending error message:', replyError);
            }
        }
    }
    
    if (interaction.commandName === 'staffinvoice') {
        // Check if user has one of the allowed roles
        const ALLOWED_ROLES = ['1391090162246877336', '1391041650586943588'];
        const hasAllowedRole = ALLOWED_ROLES.some(roleId => interaction.member.roles.cache.has(roleId));
        
        if (!hasAllowedRole) {
            await interaction.reply({
                content: 'You do not have permission to submit staff invoices.',
                flags: 64
            });
            return;
        }
        
        await interaction.deferReply();
        
        const caseId = interaction.options.getString('case_id');
        const role = interaction.options.getString('role');
        const dutyType = interaction.options.getString('duty_type');
        const hours = interaction.options.getNumber('hours') || 0;
        const reimbursements = interaction.options.getNumber('reimbursements') || 0;
        const receiptUrl = interaction.options.getString('receipt_url');
        
        try {
            // Validate role-specific requirements
            if (role === 'public_defender' && !dutyType) {
                await interaction.editReply({
                    content: 'Public Defenders must specify duty type (Duty Counsel or Regular Counsel).',
                    flags: 64
                });
                return;
            }
            
            if ((role === 'clerk' || role.includes('judge') || role === 'magistrate') && !hours) {
                await interaction.editReply({
                    content: 'Hours worked is required for your role.',
                    flags: 64
                });
                return;
            }
            
            if (reimbursements > 0 && role !== 'public_defender') {
                await interaction.editReply({
                    content: 'Only Public Defenders can request reimbursements.',
                    flags: 64
                });
                return;
            }
            
            // Calculate payment based on role
            let basePay = 0;
            let hourlyRate = 0;
            let roleDisplay = '';
            
            switch(role) {
                case 'magistrate':
                    basePay = 1000;
                    hourlyRate = 50;
                    roleDisplay = 'Magistrate';
                    break;
                case 'riding_justice':
                    basePay = 5000;
                    hourlyRate = 100;
                    roleDisplay = 'Riding Justice';
                    break;
                case 'superior_court_judge':
                    basePay = 3000;
                    hourlyRate = 50;
                    roleDisplay = 'Superior Court Judge';
                    break;
                case 'public_defender':
                    if (dutyType === 'duty_counsel') {
                        basePay = 1000;
                        roleDisplay = 'Public Defender (Duty Counsel)';
                    } else {
                        basePay = 3000;
                        roleDisplay = 'Public Defender (Regular Counsel)';
                    }
                    hourlyRate = 150;
                    break;
                case 'clerk':
                    basePay = 0;
                    hourlyRate = 25; // Assuming hourly rate for clerks
                    roleDisplay = 'Clerk';
                    break;
                case 'public_defenders_office':
                    basePay = 0;
                    hourlyRate = 0;
                    roleDisplay = 'Public Defenders Office';
                    break;
            }
            
            const hourlyPay = hours * hourlyRate;
            const totalAmount = basePay + hourlyPay + reimbursements;
            
            // Generate invoice number
            const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
            
            // Save to database
            await createStaffInvoice(
                interaction.guildId,
                interaction.channelId,
                caseId,
                interaction.user.id,
                role,
                dutyType,
                hours,
                basePay,
                hourlyRate,
                reimbursements,
                receiptUrl,
                totalAmount,
                invoiceNumber
            );
            
            // Generate receipt HTML
            const receiptHtml = generateStaffInvoiceReceipt({
                invoiceNumber,
                date: new Date(),
                userName: interaction.user.username,
                userId: interaction.user.id,
                caseId,
                roleDisplay,
                basePay,
                hours,
                hourlyRate,
                hourlyPay,
                reimbursements,
                receiptUrl,
                totalAmount
            });
            
            // Create temporary file for receipt
            const filename = `staff-invoice-${invoiceNumber}.html`;
            const filepath = `/tmp/${filename}`;
            await fs.writeFile(filepath, receiptHtml);
            
            // Create attachment
            const receiptAttachment = new AttachmentBuilder(filepath, { name: filename });
            
            // Create invoice embed
            const invoiceEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('💰 STAFF INVOICE SUBMITTED')
                .setDescription(`Invoice #${invoiceNumber}`)
                .addFields(
                    { name: 'Staff Member', value: `${interaction.user}`, inline: true },
                    { name: 'Role', value: roleDisplay, inline: true },
                    { name: 'Case ID', value: caseId, inline: true },
                    { name: 'Base Pay', value: `$${basePay.toFixed(2)}`, inline: true },
                    { name: 'Hours Worked', value: hours.toString(), inline: true },
                    { name: 'Hourly Rate', value: `$${hourlyRate.toFixed(2)}/hr`, inline: true },
                    { name: 'Hourly Pay', value: `$${hourlyPay.toFixed(2)}`, inline: true },
                    { name: 'Reimbursements', value: `$${reimbursements.toFixed(2)}`, inline: true },
                    { name: 'Total Amount', value: `**$${totalAmount.toFixed(2)}**`, inline: true }
                )
                .setTimestamp()
                .setFooter({ text: 'Invoice submitted for processing' });
            
            // Send the response with receipt
            await interaction.editReply({
                embeds: [invoiceEmbed],
                files: [receiptAttachment]
            });
            
            // Clean up temp file
            await fs.unlink(filepath);
            
            // Get Clerk of Superior Court role ID (you may need to update this)
            const CLERK_OF_SUPERIOR_COURT_ID = '1391096993270599770'; // Update this with actual channel ID
            
            try {
                const clerkChannel = await client.channels.fetch(CLERK_OF_SUPERIOR_COURT_ID);
                if (clerkChannel) {
                    const clerkEmbed = new EmbedBuilder()
                        .setColor(0x0099FF)
                        .setTitle('📋 NEW STAFF INVOICE')
                        .setDescription(`A new staff invoice has been submitted for payment.`)
                        .addFields(
                            { name: 'Invoice Number', value: invoiceNumber, inline: true },
                            { name: 'Staff Member', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Total Cost', value: `**$${totalAmount.toFixed(2)}**`, inline: true },
                            { name: 'Role', value: roleDisplay, inline: false },
                            { name: 'Case ID', value: caseId, inline: false }
                        )
                        .setTimestamp();
                    
                    await clerkChannel.send({ embeds: [clerkEmbed] });
                }
            } catch (clerkError) {
                console.error('Error notifying Clerk of Superior Court:', clerkError);
            }
            
        } catch (error) {
            console.error('Error processing staff invoice:', error);
            await interaction.editReply({
                content: 'An error occurred while processing your invoice.',
                flags: 64
            });
        }
    }
    
    if (interaction.commandName === 'minuteorder') {
        // Check if user has the required role
        const ALLOWED_ROLE_ID = '1391041650586943588';
        
        if (!interaction.member.roles.cache.has(ALLOWED_ROLE_ID)) {
            await interaction.reply({
                content: 'You do not have permission to use this command.',
                flags: 64
            });
            return;
        }
        
        await interaction.deferReply();
        
        const targetParty = interaction.options.getUser('party');
        const orderText = interaction.options.getString('order_text');
        const channel = interaction.channel;
        
        try {
            // Get case information to extract case code
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.editReply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Generate minute order ID
            const orderId = `MO-${Date.now()}`;
            
            // Generate PDF
            const pdfBuffer = await generateMinuteOrderPDF(
                caseInfo.case_code,
                orderId,
                targetParty,
                orderText,
                interaction.user,
                new Date()
            );
            
            // Create attachment
            const filename = `minute-order-${caseInfo.case_code}-${Date.now()}.pdf`;
            const attachment = new AttachmentBuilder(pdfBuffer, { name: filename });
            
            // Create minute order embed
            const minuteOrderEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('⚖️ MINUTE ORDER')
                .setDescription(`A minute order has been issued by the court.`)
                .addFields(
                    { name: 'Directed to', value: `${targetParty}`, inline: true },
                    { name: 'Issued By', value: `${interaction.user}`, inline: true },
                    { name: 'Case', value: caseInfo.case_code, inline: true },
                    { name: 'Order', value: orderText.length > 1024 ? orderText.substring(0, 1021) + '...' : orderText, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'This is an official court order' });
            
            // Send the response with PDF
            await interaction.editReply({
                content: `${targetParty}`,
                embeds: [minuteOrderEmbed],
                files: [attachment]
            });
            
            // Send follow-up notice
            await channel.send({
                content: `⚖️ **COURT ORDER** ⚖️\n${targetParty}, you have been served with a minute order. Please review the order above immediately.`
            });
            
        } catch (error) {
            console.error('Error issuing minute order:', error);
            await interaction.editReply({ 
                content: 'An error occurred while issuing the minute order.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'dej') {
        // Check if user has the allowed role
        const DEJ_ALLOWED_ROLE = '1391041650586943588';
        if (!interaction.member.roles.cache.has(DEJ_ALLOWED_ROLE)) {
            await interaction.reply({
                content: 'You do not have permission to issue DEJ orders.',
                flags: 64
            });
            return;
        }
        
        await interaction.deferReply();
        
        const targetParty = interaction.options.getUser('party');
        const duration = interaction.options.getString('duration');
        const conditions = interaction.options.getString('conditions');
        const suspendedSentence = interaction.options.getString('suspended_sentence');
        const orderLink = interaction.options.getString('order_link');
        const channel = interaction.channel;
        
        try {
            // Get case information
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.editReply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Validate Google Drive link
            if (!orderLink.includes('drive.google.com') && !orderLink.includes('docs.google.com')) {
                await interaction.editReply({
                    content: 'Please provide a valid Google Drive link for the order.',
                    flags: 64
                });
                return;
            }
            
            // Calculate first check-in date (5 days from now)
            const nextCheckin = new Date();
            nextCheckin.setDate(nextCheckin.getDate() + 5);
            
            // Create DEJ order in database
            const dejOrder = await createDEJOrder(
                interaction.guildId,
                channel.id,
                caseInfo.case_code,
                targetParty.id,
                interaction.user.id,
                duration,
                conditions,
                suspendedSentence,
                orderLink,
                nextCheckin
            );
            
            // Move channel to probation category
            const PROBATION_CATEGORY_ID = '1391073873436475492';
            await channel.setParent(PROBATION_CATEGORY_ID);
            
            // Add probation role to channel permissions
            const PROBATION_ROLE_ID = '1391100951435415643';
            await channel.permissionOverwrites.create(PROBATION_ROLE_ID, {
                ViewChannel: true,
                SendMessages: true
            });
            
            // Parse conditions into array
            const conditionsList = conditions.split(';').map(c => c.trim()).filter(c => c);
            
            // Create DEJ embed
            const dejEmbed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('⚖️ DEFERRED ENTRY OF JUDGMENT')
                .setDescription(`A Deferred Entry of Judgment has been ordered for ${targetParty}.`)
                .addFields(
                    { name: 'Subject', value: `${targetParty}`, inline: true },
                    { name: 'Duration', value: duration, inline: true },
                    { name: 'Case', value: caseInfo.case_code, inline: true },
                    { name: 'Suspended Sentence', value: suspendedSentence, inline: false },
                    { name: 'Conditions of Probation', value: conditionsList.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified', inline: false },
                    { name: '📋 Check-in Requirements', value: `${targetParty} must check in with probation every **5 days**. First check-in due: **${nextCheckin.toLocaleDateString()}**`, inline: false },
                    { name: 'Order Document', value: `[View Order](${orderLink})`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Failure to comply with probation terms may result in execution of suspended sentence' });
            
            // Send the response
            await interaction.editReply({
                content: `${targetParty}`,
                embeds: [dejEmbed]
            });
            
            // Post probation information
            const probationInfoEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('📋 PROBATION INFORMATION')
                .setDescription(`This channel has been moved to the Probation category. The Probation Department now has access.`)
                .addFields(
                    { name: 'Probationer', value: `${targetParty}`, inline: true },
                    { name: 'Probation Period', value: duration, inline: true },
                    { name: 'Next Check-in', value: nextCheckin.toLocaleDateString(), inline: true },
                    { name: 'Check-in Schedule', value: 'Every 5 days', inline: false },
                    { name: 'Important Notice', value: `${targetParty} must report to this channel every 5 days. Failure to check in will be reported to the court.`, inline: false }
                );
            
            await channel.send({ embeds: [probationInfoEmbed] });
            
            // Send notice to probationer
            await channel.send({
                content: `⚠️ **PROBATION NOTICE** ⚠️\n${targetParty}, you have been placed on probation with a Deferred Entry of Judgment. You MUST check in to this channel every 5 days starting ${nextCheckin.toLocaleDateString()}. Your check-in should include:\n\n1. Confirmation of compliance with all probation conditions\n2. Any issues or concerns\n3. Updates on progress\n\nFailure to check in will result in a violation report to the court.`
            });
            
        } catch (error) {
            console.error('Error issuing DEJ order:', error);
            await interaction.editReply({
                content: 'An error occurred while issuing the DEJ order.',
                flags: 64
            });
        }
    }
    
    if (interaction.commandName === 'hearing') {
        await interaction.deferReply();
        
        const dateStr = interaction.options.getString('date');
        const timeStr = interaction.options.getString('time');
        const timezone = interaction.options.getString('timezone');
        const location = interaction.options.getString('location');
        const isVirtual = interaction.options.getBoolean('virtual');
        const channel = interaction.channel;
        
        try {
            // Get case information
            const caseInfo = await getCaseByChannel(interaction.guildId, channel.id);
            
            if (!caseInfo) {
                await interaction.editReply({
                    content: 'This command can only be used in an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Parse date and time using moment-timezone
            const dateTimeStr = `${dateStr} ${timeStr}`;
            const hearingMoment = moment.tz(dateTimeStr, 'MM/DD/YYYY hh:mm A', timezone);
            
            if (!hearingMoment.isValid()) {
                await interaction.editReply({
                    content: 'Invalid date or time format. Please use MM/DD/YYYY for date and HH:MM AM/PM for time.',
                    flags: 64
                });
                return;
            }
            
            // Convert to UTC for storage
            const hearingDate = hearingMoment.toDate();
            
            // Get all assigned parties (judge, clerk, plaintiffs, defendants)
            const assignedParties = [];
            
            // Add judge
            if (caseInfo.judge_id) {
                assignedParties.push(caseInfo.judge_id);
            }
            
            // Add clerk if exists
            if (caseInfo.clerk_id) {
                assignedParties.push(caseInfo.clerk_id);
            }
            
            // Add plaintiffs
            if (caseInfo.plaintiff_ids) {
                const plaintiffIds = caseInfo.plaintiff_ids.split(',').map(id => id.trim());
                assignedParties.push(...plaintiffIds);
            }
            
            // Add defendants
            if (caseInfo.defendant_ids) {
                const defendantIds = caseInfo.defendant_ids.split(',').map(id => id.trim());
                assignedParties.push(...defendantIds);
            }
            
            // Create hearing in database
            const hearing = await createHearing(
                interaction.guildId,
                channel.id,
                caseInfo.case_code,
                hearingDate,
                timezone,
                location,
                isVirtual,
                assignedParties.join(','),
                interaction.user.id
            );
            
            // Format location display
            const locationDisplay = isVirtual ? `Virtual Hearing (${location})` : location;
            
            // Create timezone display
            const timezoneDisplay = {
                'America/New_York': 'Eastern Time (ET)',
                'America/Chicago': 'Central Time (CT)',
                'America/Denver': 'Mountain Time (MT)',
                'America/Los_Angeles': 'Pacific Time (PT)',
                'America/Anchorage': 'Alaska Time (AKT)',
                'Pacific/Honolulu': 'Hawaii Time (HT)',
                'UTC': 'GMT/UTC',
                'Europe/London': 'British Time (BST/GMT)',
                'Europe/Paris': 'Central European Time (CET)',
                'Europe/Athens': 'Eastern European Time (EET)',
                'Europe/Moscow': 'Moscow Time (MSK)',
                'Asia/Kolkata': 'India Standard Time (IST)',
                'Asia/Shanghai': 'China Standard Time (CST)',
                'Asia/Tokyo': 'Japan Standard Time (JST)',
                'Asia/Seoul': 'Korea Standard Time (KST)',
                'Asia/Singapore': 'Singapore Time (SGT)',
                'Australia/Sydney': 'Australian Eastern Time (AET)',
                'Australia/Perth': 'Australian Western Time (AWT)',
                'Pacific/Auckland': 'New Zealand Time (NZST)',
                'Asia/Dubai': 'Dubai Time (GST)',
                'Asia/Jerusalem': 'Israel Standard Time (IST)',
                'Africa/Johannesburg': 'South Africa Time (SAST)',
                'America/Sao_Paulo': 'Brazil Time (BRT)',
                'America/Argentina/Buenos_Aires': 'Argentina Time (ART)',
                'America/Mexico_City': 'Mexico City Time (CST)'
            }[timezone] || timezone;
            
            // Create hearing embed
            const hearingEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('⚖️ HEARING SCHEDULED')
                .setDescription(`A hearing has been scheduled for case ${caseInfo.case_code}`)
                .addFields(
                    { name: 'Date', value: hearingMoment.format('MMMM D, YYYY'), inline: true },
                    { name: 'Time', value: `${hearingMoment.format('h:mm A')} ${timezoneDisplay}`, inline: true },
                    { name: 'Location', value: locationDisplay, inline: true },
                    { name: 'Type', value: isVirtual ? 'Virtual' : 'In-Person', inline: true },
                    { name: 'Scheduled By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Hearing ID', value: `H-${hearing.id}`, inline: true }
                )
                .addFields({
                    name: 'Reminders',
                    value: '• You will receive a reminder 1 hour before the hearing\n• You will receive a notification when the hearing starts',
                    inline: false
                })
                .setTimestamp()
                .setFooter({ text: 'All parties are required to attend' });
            
            // Tag all parties
            const partyTags = assignedParties.map(id => `<@${id}>`).join(' ');
            
            await interaction.editReply({
                content: `${partyTags}\n**HEARING NOTICE:** Please note the scheduled hearing details below.`,
                embeds: [hearingEmbed]
            });
            
        } catch (error) {
            console.error('Error scheduling hearing:', error);
            await interaction.editReply({
                content: 'An error occurred while scheduling the hearing.',
                flags: 64
            });
        }
    }
    
    if (interaction.commandName === 'noa') {
        // Check if user has the required role
        const ATTORNEY_ROLE_ID = '1378582412698845264';
        
        // Debug logging
        console.log('NOA Command - User roles:', Array.from(interaction.member.roles.cache.keys()));
        console.log('NOA Command - Looking for role:', ATTORNEY_ROLE_ID);
        console.log('NOA Command - Has role:', interaction.member.roles.cache.has(ATTORNEY_ROLE_ID));
        
        if (!interaction.member.roles.cache.has(ATTORNEY_ROLE_ID)) {
            await interaction.reply({
                content: 'You do not have permission to file a Notice of Appearance. Only licensed attorneys may use this command.',
                flags: 64
            });
            return;
        }
        
        await interaction.deferReply();
        
        const caseChannel = interaction.options.getChannel('case_channel');
        const appearingFor = interaction.options.getString('appearing_for');
        const barNumber = interaction.options.getString('bar_number');
        
        try {
            // Get case information from the specified channel
            const caseInfo = await getCaseByChannel(interaction.guildId, caseChannel.id);
            
            if (!caseInfo) {
                await interaction.editReply({
                    content: 'The specified channel is not an active case channel.',
                    flags: 64
                });
                return;
            }
            
            // Check if a final ruling has been issued (appeal deadline exists)
            const appealDeadline = await getActiveAppealDeadline(interaction.guildId, caseChannel.id);
            
            if (appealDeadline) {
                await interaction.editReply({
                    content: 'A final ruling has been issued in this case. New Notices of Appearance cannot be filed after a final ruling. If you need to appeal, please use the /appealnotice command.',
                    flags: 64
                });
                return;
            }
            
            // Get plaintiff and defendant information
            const plaintiffIds = caseInfo.plaintiff_ids ? caseInfo.plaintiff_ids.split(',') : [];
            const defendantIds = caseInfo.defendant_ids ? caseInfo.defendant_ids.split(',') : [];
            
            // Get user objects for plaintiffs and defendants
            const plaintiffs = [];
            const defendants = [];
            
            for (const id of plaintiffIds) {
                try {
                    const user = await client.users.fetch(id.trim());
                    if (user) plaintiffs.push(user);
                } catch (e) {
                    console.error(`Could not fetch plaintiff with ID ${id}:`, e);
                }
            }
            
            for (const id of defendantIds) {
                try {
                    const user = await client.users.fetch(id.trim());
                    if (user) defendants.push(user);
                } catch (e) {
                    console.error(`Could not fetch defendant with ID ${id}:`, e);
                }
            }
            
            // Prepare names for the document
            const plaintiffNames = plaintiffs.length > 0 
                ? plaintiffs.map(u => u.username).join(', ')
                : 'Unknown Plaintiff';
            
            const defendantNames = defendants.length > 0
                ? defendants.map(u => u.username).join(', ')
                : 'Unknown Defendant';
            
            // Generate NOA ID
            const noaId = `NOA-${Date.now()}`;
            
            // Generate PDF
            const pdfBuffer = await generateNOAPDF(
                plaintiffNames,
                defendantNames,
                caseChannel.name,
                interaction.user.username,
                appearingFor,
                barNumber,
                new Date()
            );
            
            // Create attachment
            const filename = `notice-of-appearance-${caseInfo.case_code}-${Date.now()}.pdf`;
            const attachment = new AttachmentBuilder(pdfBuffer, { name: filename });
            
            // Add attorney to the case channel
            await caseChannel.permissionOverwrites.edit(interaction.user.id, {
                ViewChannel: true,
                SendMessages: true
            });
            
            // Create NOA embed
            const noaEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('📋 NOTICE OF APPEARANCE')
                .setDescription(`${interaction.user} has filed a Notice of Appearance.`)
                .addFields(
                    { name: 'Attorney', value: `${interaction.user}`, inline: true },
                    { name: 'Appearing for', value: appearingFor.charAt(0).toUpperCase() + appearingFor.slice(1), inline: true },
                    { name: 'Bar Number', value: barNumber, inline: true },
                    { name: 'Case', value: caseInfo.case_code, inline: true },
                    { name: 'Document ID', value: noaId, inline: true }
                )
                .setTimestamp()
                .setFooter({ text: 'This attorney has been added to the case' });
            
            // Send to the interaction channel
            await interaction.editReply({
                content: `Notice of Appearance filed successfully. You have been added to ${caseChannel}.`,
                embeds: [noaEmbed],
                files: [attachment]
            });
            
            // Also send to the case channel
            const caseChannelEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('⚖️ ATTORNEY APPEARANCE')
                .setDescription(`A new attorney has entered an appearance in this case.`)
                .addFields(
                    { name: 'Attorney', value: `${interaction.user}`, inline: true },
                    { name: 'Representing', value: appearingFor.charAt(0).toUpperCase() + appearingFor.slice(1), inline: true },
                    { name: 'Bar Number', value: barNumber, inline: true }
                )
                .setTimestamp();
            
            await caseChannel.send({
                content: `All parties please note: ${interaction.user} has entered an appearance as counsel for the ${appearingFor}.`,
                embeds: [caseChannelEmbed],
                files: [new AttachmentBuilder(pdfBuffer, { name: filename })]
            });
            
        } catch (error) {
            console.error('Error filing NOA:', error);
            await interaction.editReply({ 
                content: 'An error occurred while filing the Notice of Appearance.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'summon') {
        await interaction.deferReply();
        
        const targetNickname = interaction.options.getString('target');
        const plaintiff = interaction.options.getString('plaintiff');
        const caseLink = interaction.options.getString('case_link');
        const SERVER_ID = '1348177368451121185';
        
        try {
            // Get the guild
            const guild = await client.guilds.fetch(SERVER_ID);
            if (!guild) {
                await interaction.editReply({
                    content: 'Unable to access the required server.',
                    flags: 64
                });
                return;
            }
            
            // Fetch all members to ensure we have the latest data
            await guild.members.fetch();
            
            // Find member with matching nickname (case-insensitive)
            const targetMember = guild.members.cache.find(member => 
                member.nickname && member.nickname.toLowerCase() === targetNickname.toLowerCase()
            );
            
            if (!targetMember) {
                await interaction.editReply({
                    content: `No user found with the nickname "${targetNickname}" in the server.`,
                    flags: 64
                });
                return;
            }
            
            // Prepare the summons message
            const currentDate = new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
            
            const summonsMessage = `YOU ARE HEREBY SUMMONED and required to serve upon plaintiff **${plaintiff}** an answer to the complaint which is herewith served upon you, within seven (7) days after service of this summons upon you, exclusive of the day of service. (${currentDate})

IF YOU FAIL TO DO SO, judgment by default will be taken against you for the relief demanded in the complaint.

You are also required to file your answer or motion with the Clerk of this Court within the same time period.

**Case Details:** ${caseLink}`;
            
            // Try to send DM
            try {
                await targetMember.send(summonsMessage);
                
                // Create success embed
                const successEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('⚖️ SUMMONS SERVED')
                    .setDescription('The legal summons has been successfully served.')
                    .addFields(
                        { name: 'Target', value: `${targetMember.user.tag} (${targetNickname})`, inline: true },
                        { name: 'Plaintiff', value: plaintiff, inline: true },
                        { name: 'Date Served', value: currentDate, inline: true },
                        { name: 'Response Due', value: 'Within 7 days', inline: true },
                        { name: 'Case Link', value: `[View Case](${caseLink})`, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: `Served by ${interaction.user.username}` });
                
                await interaction.editReply({
                    content: 'Summons successfully served via direct message.',
                    embeds: [successEmbed]
                });
                
            } catch (dmError) {
                // If DM fails (user has DMs disabled)
                await interaction.editReply({
                    content: `Unable to send summons to ${targetMember.user.tag}. They may have DMs disabled or blocked the bot.`,
                    flags: 64
                });
            }
            
        } catch (error) {
            console.error('Error processing summon command:', error);
            await interaction.editReply({
                content: 'An error occurred while processing the summons.',
                flags: 64
            });
        }
    }

    if (interaction.commandName === 'publicsummons') {
        await interaction.deferReply();
        
        const summonsType = interaction.options.getString('type');
        const targetUsername = interaction.options.getString('target');
        const caseChannel = interaction.options.getChannel('case_channel');
        const NOTIFICATION_CHANNEL_ID = '1352760271084716213';
        
        try {
            // Get the notification channel
            const notificationChannel = await client.channels.fetch(NOTIFICATION_CHANNEL_ID);
            if (!notificationChannel) {
                await interaction.editReply({
                    content: 'Unable to find the notification channel.',
                    flags: 64
                });
                return;
            }

            if (summonsType === 'criminal') {
                // Criminal summons with wanted poster PDF
                const pdfBuffer = await generateWantedPosterPDF(targetUsername, caseChannel.name, interaction.user.username);
                const attachment = new AttachmentBuilder(pdfBuffer, { name: `${targetUsername}-Wanted-Poster.pdf` });
                
                // Create embed
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚨 CRIMINAL BENCH WARRANT ISSUED 🚨')
                    .setDescription(`${targetUsername}, A bench warrant has been issued for your arrest in the matter of **${caseChannel.name}**.\n\nYou are commanded to surrender yourself to any law enforcement agency immediately. Failure to do so may result in additional criminal charges.\n\nAll Law Enforcement Officers and certified bounty agents are commanded to arrest the above-named individual and bring them before this court without unnecessary delay.\n\n📄 **See attached wanted poster for details**`)
                    .setTimestamp()
                    .setFooter({ text: `Issued by ${interaction.user.username}` });
                
                // Send to notification channel
                await notificationChannel.send({
                    embeds: [embed],
                    files: [attachment]
                });
                
                await interaction.editReply({
                    content: `Criminal bench warrant has been issued for ${targetUsername} and posted to the public summons channel.`,
                    embeds: [embed],
                    files: [attachment]
                });
                
            } else {
                // Civil summons
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('⚖️ CIVIL SUMMONS - LEGAL NOTICE ⚖️')
                    .setDescription(`**SUPERIOR COURT OF RIDGEWAY**\n\n**TO:** ${targetUsername}\n\n**YOU ARE BEING SUED**\n\nYou are hereby notified that a civil action has been filed against you in the Superior Court of Ridgeway.\n\n**CASE:** ${caseChannel.name}\n\n**IMPORTANT NOTICE:**\nYou have **SEVEN (7) DAYS** from first publication of this notice to file a response with the Court or face **DEFAULT JUDGMENT**.\n\nFailure to respond within the prescribed time period may result in judgment being entered against you for the relief demanded in the complaint, which may include monetary damages, injunctive relief, or other remedies sought by the plaintiff.\n\n**YOUR RIGHTS:**\n• You have the right to file an answer to the complaint\n• You have the right to be represented by counsel\n• You have the right to dispute the claims made against you\n• You have the right to assert counterclaims or defenses\n\n**TO RESPOND:**\nFile your answer with the Clerk of Court and serve a copy upon the plaintiff or their attorney within the time limit specified above.`)
                    .addFields(
                        { name: 'Response Deadline', value: '7 days from publication', inline: true },
                        { name: 'Court', value: 'Superior Court of Ridgeway', inline: true },
                        { name: 'Case', value: caseChannel.name, inline: true }
                    )
                    .setTimestamp()
                    .setFooter({ text: `Published by ${interaction.user.username} | This is a legal notice with legal consequences` });
                
                // Send to notification channel
                await notificationChannel.send({
                    embeds: [embed]
                });
                
                await interaction.editReply({
                    content: `Civil summons has been issued for ${targetUsername} and posted to the public summons channel.`,
                    embeds: [embed]
                });
            }
            
        } catch (error) {
            console.error('Error processing public summons:', error);
            await interaction.editReply({
                content: 'An error occurred while processing the public summons.',
                flags: 64
            });
        }
    }
    
    if (interaction.commandName === 'imposefee') {
        const targetUser = interaction.options.getUser('target');
        const category = interaction.options.getString('category');
        
        try {
            // Get case info
            const caseInfo = await getCaseByChannel(interaction.guildId, interaction.channelId);
            if (!caseInfo) {
                await interaction.reply({ 
                    content: 'This channel is not associated with a case. Please use this command in a case channel.', 
                    flags: 64 
                });
                return;
            }
            
            // Fee amounts mapping
            const feeAmounts = {
                'initial_civil': 435,
                'initial_small_claims': 75,
                'summary_judgement': 500,
                'general_motion': 100,
                'frequent_filer': 100,
                'summons': 75,
                'summons_publication': 200,
                'hearing_scheduling': 60,
                'vehicle_forfeiture': 100,
                'general_forfeiture': 200
            };
            
            const feeCategoryNames = {
                'initial_civil': 'Initial Motion Civil Case Cost',
                'initial_small_claims': 'Initial Motion Small Claims Case',
                'summary_judgement': 'Summary Judgement Motion',
                'general_motion': 'General Motion Cost',
                'frequent_filer': 'Small Claims Frequent Filer Fee',
                'summons': 'Summons',
                'summons_publication': 'Summons by Publication',
                'hearing_scheduling': 'Hearing Scheduling',
                'vehicle_forfeiture': 'Petition for Vehicle Forfeiture',
                'general_forfeiture': 'Petition for General Forfeiture'
            };
            
            const amount = feeAmounts[category];
            const categoryName = feeCategoryNames[category];
            
            // Generate random invoice number (max 20 chars)
            // Use base36 timestamp + 3 digit random for uniqueness
            const timestamp = Date.now().toString(36).toUpperCase();
            const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
            const invoiceNumber = `INV-${timestamp}-${random}`;
            
            // Create fee invoice in database
            await createFeeInvoice(
                interaction.guildId,
                interaction.channelId,
                caseInfo.case_code,
                targetUser.id,
                categoryName,
                amount,
                invoiceNumber
            );
            
            // Create embed
            const embed = new EmbedBuilder()
                .setColor(0xFF6347)
                .setTitle('Court Fee Imposed')
                .setDescription(`A court fee has been imposed on ${targetUser}`)
                .addFields(
                    { name: 'Case Code', value: caseInfo.case_code, inline: true },
                    { name: 'Fee Category', value: categoryName, inline: true },
                    { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
                    { name: 'Invoice Number', value: invoiceNumber, inline: true },
                    { name: 'Status', value: '⏳ Unpaid', inline: true },
                    { name: 'Imposed By', value: interaction.user.toString(), inline: true }
                )
                .setTimestamp()
                .setFooter({ text: 'Use /executefee to mark as paid' });
            
            await interaction.reply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error imposing fee:', error);
            await interaction.reply({ 
                content: 'An error occurred while imposing the fee.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'feestatus') {
        const targetUser = interaction.options.getUser('target');
        
        try {
            // Get case info
            const caseInfo = await getCaseByChannel(interaction.guildId, interaction.channelId);
            if (!caseInfo) {
                await interaction.reply({ 
                    content: 'This channel is not associated with a case. Please use this command in a case channel.', 
                    flags: 64 
                });
                return;
            }
            
            // Get fees for this user in this case
            const fees = await getFeesByUserAndCase(interaction.guildId, targetUser.id, caseInfo.case_code);
            
            if (fees.length === 0) {
                await interaction.reply({
                    content: `No fees found for ${targetUser} in case ${caseInfo.case_code}.`,
                    flags: 64
                });
                return;
            }
            
            // Calculate totals
            const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
            const paidFees = fees.filter(fee => fee.status === 'paid');
            const unpaidFees = fees.filter(fee => fee.status === 'unpaid');
            const totalPaid = paidFees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
            const totalUnpaid = unpaidFees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
            
            // Create embed
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`Fee Status for ${targetUser.username}`)
                .setDescription(`Case: ${caseInfo.case_code}`)
                .addFields(
                    { name: 'Total Fees', value: `$${totalFees.toFixed(2)}`, inline: true },
                    { name: 'Total Paid', value: `$${totalPaid.toFixed(2)}`, inline: true },
                    { name: 'Balance Due', value: `$${totalUnpaid.toFixed(2)}`, inline: true }
                )
                .setTimestamp();
            
            // Add fee details
            if (unpaidFees.length > 0) {
                const unpaidList = unpaidFees.map(fee => 
                    `• ${fee.fee_category}: $${parseFloat(fee.amount).toFixed(2)} (${fee.invoice_number})`
                ).join('\\n');
                embed.addFields({ name: '❌ Unpaid Fees', value: unpaidList || 'None', inline: false });
            }
            
            if (paidFees.length > 0) {
                const paidList = paidFees.map(fee => 
                    `• ${fee.fee_category}: $${parseFloat(fee.amount).toFixed(2)} (${fee.invoice_number})`
                ).join('\\n');
                embed.addFields({ name: '✅ Paid Fees', value: paidList || 'None', inline: false });
            }
            
            await interaction.reply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error checking fee status:', error);
            await interaction.reply({ 
                content: 'An error occurred while checking fee status.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'executefee') {
        const targetUser = interaction.options.getUser('target');
        const invoiceNumber = interaction.options.getString('invoice');
        
        try {
            // Get the fee by invoice number
            const fee = await getFeeByInvoiceNumber(interaction.guildId, invoiceNumber);
            
            if (!fee) {
                await interaction.reply({
                    content: `No fee found with invoice number: ${invoiceNumber}`,
                    flags: 64
                });
                return;
            }
            
            if (fee.user_id !== targetUser.id) {
                await interaction.reply({
                    content: `Invoice ${invoiceNumber} does not belong to ${targetUser}.`,
                    flags: 64
                });
                return;
            }
            
            if (fee.status === 'paid') {
                await interaction.reply({
                    content: `Invoice ${invoiceNumber} has already been paid.`,
                    flags: 64
                });
                return;
            }
            
            // Mark as paid
            await markFeePaid(interaction.guildId, invoiceNumber, interaction.user.id);
            
            // Create confirmation embed
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('Fee Payment Executed')
                .setDescription(`Fee has been marked as paid`)
                .addFields(
                    { name: 'Invoice Number', value: invoiceNumber, inline: true },
                    { name: 'Amount', value: `$${parseFloat(fee.amount).toFixed(2)}`, inline: true },
                    { name: 'Fee Category', value: fee.fee_category, inline: true },
                    { name: 'Paid By', value: targetUser.toString(), inline: true },
                    { name: 'Processed By', value: interaction.user.toString(), inline: true },
                    { name: 'Status', value: '✅ Paid', inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error executing fee payment:', error);
            await interaction.reply({ 
                content: 'An error occurred while executing the fee payment.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'sudofeestatus') {
        const targetUser = interaction.options.getUser('target');
        
        try {
            // Get all fees for this user across all cases
            const allFees = await getAllFeesByUser(interaction.guildId, targetUser.id);
            
            if (allFees.length === 0) {
                await interaction.reply({
                    content: `No fees found for ${targetUser} across any cases.`,
                    flags: 64
                });
                return;
            }
            
            // Group fees by case
            const feesByCase = {};
            allFees.forEach(fee => {
                if (!feesByCase[fee.case_code]) {
                    feesByCase[fee.case_code] = [];
                }
                feesByCase[fee.case_code].push(fee);
            });
            
            // Calculate totals
            const totalFees = allFees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
            const totalPaid = allFees.filter(fee => fee.status === 'paid')
                .reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
            const totalUnpaid = allFees.filter(fee => fee.status === 'unpaid')
                .reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
            
            // Create embed
            const embed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle(`Complete Fee Status for ${targetUser.username}`)
                .setDescription('Fee summary across all cases')
                .addFields(
                    { name: 'Total Fees (All Cases)', value: `$${totalFees.toFixed(2)}`, inline: true },
                    { name: 'Total Paid', value: `$${totalPaid.toFixed(2)}`, inline: true },
                    { name: 'Total Balance Due', value: `$${totalUnpaid.toFixed(2)}`, inline: true }
                )
                .setTimestamp();
            
            // Add breakdown by case
            for (const [caseCode, fees] of Object.entries(feesByCase)) {
                const caseTotalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
                const casePaid = fees.filter(fee => fee.status === 'paid')
                    .reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
                const caseUnpaid = fees.filter(fee => fee.status === 'unpaid')
                    .reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
                
                const feeList = fees.map(fee => {
                    const status = fee.status === 'paid' ? '✅' : '❌';
                    return `${status} ${fee.fee_category}: $${parseFloat(fee.amount).toFixed(2)} (${fee.invoice_number})`;
                }).join('\\n');
                
                embed.addFields({
                    name: `Case ${caseCode} - Total: $${caseTotalFees.toFixed(2)} (Paid: $${casePaid.toFixed(2)}, Due: $${caseUnpaid.toFixed(2)})`,
                    value: feeList || 'No fees',
                    inline: false
                });
            }
            
            await interaction.reply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error checking sudo fee status:', error);
            await interaction.reply({ 
                content: 'An error occurred while checking fee status across all cases.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'feesheet') {
        try {
            // Fee sheet data
            const feeSheet = [
                { category: 'Initial Motion Civil Case Cost', amount: 435 },
                { category: 'Initial Motion Small Claims Case', amount: 75 },
                { category: 'Summary Judgement Motion', amount: 500 },
                { category: 'General Motion Cost', amount: 100 },
                { category: 'Small Claims Frequent Filer Fee', amount: 100 },
                { category: 'Summons', amount: 75 },
                { category: 'Summons by Publication', amount: 200 },
                { category: 'Hearing Scheduling', amount: 60 },
                { category: 'Petition for Vehicle Forfeiture', amount: 100 },
                { category: 'Petition for General Forfeiture', amount: 200 }
            ];
            
            // Create embed
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('📋 Court Fee Sheet')
                .setDescription('Complete list of court fees that can be imposed using `/imposefee`')
                .setTimestamp()
                .setFooter({ text: 'Use /imposefee to apply these fees to a user' });
            
            // Add fee categories
            feeSheet.forEach(fee => {
                embed.addFields({
                    name: fee.category,
                    value: `**$${fee.amount.toFixed(2)}**`,
                    inline: true
                });
            });
            
            await interaction.reply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error displaying fee sheet:', error);
            await interaction.reply({ 
                content: 'An error occurred while displaying the fee sheet.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'filesmallclaim') {
        try {
            // Load the empty S100 PDF
            const pdfBytes = await fs.readFile('./RW S100.pdf');
            
            // Create attachment
            const attachment = new AttachmentBuilder(pdfBytes, { 
                name: 'S100-Small-Claims-Form.pdf' 
            });
            
            // Create embed with instructions
            const embed = new EmbedBuilder()
                .setColor(0x000000)
                .setTitle('SMALL CLAIMS COURT - FORM S100')
                .setDescription('**INSTRUCTIONS FOR FILING A SMALL CLAIMS ACTION**')
                .addFields(
                    { 
                        name: 'STEP 1 - COMPLETE FORM', 
                        value: 'Complete all required fields on Form S100. Ensure all information is accurate and legible.', 
                        inline: false 
                    },
                    { 
                        name: 'STEP 2 - SAVE DOCUMENT', 
                        value: 'Download and save the completed form to your device.', 
                        inline: false 
                    },
                    { 
                        name: 'STEP 3 - ACCESS FILING SYSTEM', 
                        value: 'Navigate to the Ridgeway Courts electronic filing portal at https://rwcourts.org/file-at-home', 
                        inline: false 
                    },
                    { 
                        name: 'STEP 4 - INITIATE CASE', 
                        value: 'Select "Initialize New Case" from the main menu.', 
                        inline: false 
                    },
                    { 
                        name: 'STEP 5 - SELECT VENUE', 
                        value: 'Choose "Stationhouse Courtroom" as the designated venue.', 
                        inline: false 
                    },
                    { 
                        name: 'STEP 6 - CASE TYPE DESIGNATION', 
                        value: 'Select "Small Claims" from the case type dropdown menu.', 
                        inline: false 
                    },
                    { 
                        name: 'STEP 7 - COMPLETE FILING', 
                        value: 'Complete all remaining required fields and submit your filing. You will receive a confirmation number upon successful submission.', 
                        inline: false 
                    }
                )
                .setTimestamp()
                .setFooter({ text: 'Superior Court of Ridgeway - Small Claims Division' });
            
            await interaction.reply({
                embeds: [embed],
                files: [attachment]
            });
            
        } catch (error) {
            console.error('Error providing S100 form:', error);
            await interaction.reply({ 
                content: 'An error occurred while retrieving the S100 form.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'docket') {
        // Check if user has the required role
        const requiredRoleId = '1378583580988670022';
        if (!interaction.member.roles.cache.has(requiredRoleId)) {
            await interaction.reply({ 
                content: 'You do not have permission to use this command.', 
                flags: 64 
            });
            return;
        }
        
        await interaction.deferReply();
        
        const selectedJudge = interaction.options.getUser('judge');
        
        try {
            // Get all cases where the selected user is the judge
            const cases = await getCasesByJudge(interaction.guildId, selectedJudge.id);
            
            if (cases.length === 0) {
                await interaction.editReply({
                    content: `No cases found where ${selectedJudge} is assigned as judge.`,
                    flags: 64
                });
                return;
            }
            
            // Create the docket embed
            const docketEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`⚖️ CASE DOCKET - Judge ${selectedJudge.username}`)
                .setDescription(`Showing all cases assigned to ${selectedJudge}`)
                .setTimestamp()
                .setFooter({ text: `Total Cases: ${cases.length}` });
            
            // Add each case to the embed
            for (const caseData of cases) {
                // Parse plaintiff and defendant IDs
                const plaintiffIds = caseData.plaintiff_ids.split(',').map(id => id.trim());
                const defendantIds = caseData.defendant_ids ? caseData.defendant_ids.split(',').map(id => id.trim()) : [];
                
                // Fetch user details for plaintiffs and defendants
                const plaintiffs = [];
                const defendants = [];
                
                for (const id of plaintiffIds) {
                    try {
                        const user = await client.users.fetch(id);
                        plaintiffs.push(user.username);
                    } catch (e) {
                        plaintiffs.push(`User ${id}`);
                    }
                }
                
                for (const id of defendantIds) {
                    try {
                        const user = await client.users.fetch(id);
                        defendants.push(user.username);
                    } catch (e) {
                        defendants.push(`User ${id}`);
                    }
                }
                
                // Format case title
                let caseTitle;
                if (defendants.length === 0) {
                    caseTitle = `In Re: ${plaintiffs.join(', ')}`;
                } else {
                    caseTitle = `${plaintiffs.join(', ')} v. ${defendants.join(', ')}`;
                }
                
                // Get the channel
                let channelMention = 'Channel not found';
                try {
                    const channel = await client.channels.fetch(caseData.channel_id);
                    if (channel) {
                        channelMention = `<#${channel.id}>`;
                    }
                } catch (e) {
                    // Channel might be deleted
                }
                
                // Add field for this case
                docketEmbed.addFields({
                    name: caseData.case_code,
                    value: `**${caseTitle}**\nCase Channel: ${channelMention}\nStatus: ${caseData.status || 'active'}`,
                    inline: false
                });
                
                // Discord embed field limit is 25
                if (docketEmbed.data.fields.length >= 25) {
                    docketEmbed.setFooter({ text: `Showing first 25 cases of ${cases.length} total` });
                    break;
                }
            }
            
            await interaction.editReply({
                embeds: [docketEmbed]
            });
            
        } catch (error) {
            console.error('Error generating docket:', error);
            await interaction.editReply({ 
                content: 'An error occurred while generating the docket.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'allsearch') {
        // Check if user has the required role
        const requiredRoleId = '1392743464919236660';
        if (!interaction.member.roles.cache.has(requiredRoleId)) {
            await interaction.reply({ 
                content: 'You do not have permission to use this command.', 
                flags: 64 
            });
            return;
        }
        
        await interaction.deferReply();
        
        const keyword = interaction.options.getString('keyword').toLowerCase();
        const ARCHIVE_CATEGORY_ID = '1391054003252756642';
        
        try {
            // Get the archive category
            const archiveCategory = await interaction.guild.channels.fetch(ARCHIVE_CATEGORY_ID);
            if (!archiveCategory || archiveCategory.type !== ChannelType.GuildCategory) {
                await interaction.editReply({
                    content: 'Archive category not found.',
                    flags: 64
                });
                return;
            }
            
            // Get all channels in the archive category
            const archivedChannels = archiveCategory.children.cache.filter(channel => 
                channel.type === ChannelType.GuildText
            );
            
            if (archivedChannels.size === 0) {
                await interaction.editReply({
                    content: 'No archived case channels found.',
                    flags: 64
                });
                return;
            }
            
            const searchResults = [];
            let channelsSearched = 0;
            const maxResults = 10; // Limit results to prevent overwhelming response
            
            // Search through each archived channel
            for (const [channelId, channel] of archivedChannels) {
                if (searchResults.length >= maxResults) break;
                
                try {
                    // Search messages in the channel
                    let messages = await channel.messages.fetch({ limit: 100 });
                    let oldestMessage = messages.last();
                    
                    // Keep fetching older messages until we've searched the whole channel
                    while (oldestMessage && searchResults.length < maxResults) {
                        // Search through the fetched messages
                        for (const [msgId, message] of messages) {
                            if (message.content.toLowerCase().includes(keyword) || 
                                (message.embeds.length > 0 && 
                                 message.embeds.some(embed => 
                                    (embed.description && embed.description.toLowerCase().includes(keyword)) ||
                                    (embed.title && embed.title.toLowerCase().includes(keyword)) ||
                                    (embed.fields && embed.fields.some(field => 
                                        field.value.toLowerCase().includes(keyword) || 
                                        field.name.toLowerCase().includes(keyword)
                                    ))
                                 ))
                            ) {
                                // Get case info from the channel
                                const caseData = await getCaseByChannel(interaction.guildId, channelId);
                                
                                if (!searchResults.find(r => r.channelId === channelId)) {
                                    searchResults.push({
                                        channelId: channelId,
                                        channelName: channel.name,
                                        caseCode: caseData ? caseData.case_code : channel.name,
                                        matchedMessage: message.content.length > 100 
                                            ? message.content.substring(0, 100) + '...' 
                                            : message.content,
                                        messageUrl: message.url,
                                        caseData: caseData
                                    });
                                    break; // Only need one match per channel
                                }
                            }
                        }
                        
                        // Fetch more messages if we haven't found a match yet
                        if (!searchResults.find(r => r.channelId === channelId)) {
                            try {
                                messages = await channel.messages.fetch({ 
                                    limit: 100, 
                                    before: oldestMessage.id 
                                });
                                oldestMessage = messages.last();
                            } catch (e) {
                                break; // No more messages to fetch
                            }
                        } else {
                            break; // Found a match, move to next channel
                        }
                    }
                    
                    channelsSearched++;
                } catch (error) {
                    console.error(`Error searching channel ${channel.name}:`, error);
                }
            }
            
            if (searchResults.length === 0) {
                await interaction.editReply({
                    content: `No closed cases found containing the keyword: **${keyword}**\n_Searched ${channelsSearched} archived channels._`,
                    flags: 64
                });
                return;
            }
            
            // Create the search results embed
            const searchEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`🔍 CLOSED CASES SEARCH RESULTS`)
                .setDescription(`Found ${searchResults.length} closed case(s) containing: **${keyword}**`)
                .setTimestamp()
                .setFooter({ text: `Searched ${channelsSearched} archived channels` });
            
            // Add each case to the embed
            for (const result of searchResults) {
                let caseTitle = result.caseCode;
                
                // If we have case data, format a proper title
                if (result.caseData) {
                    const plaintiffIds = result.caseData.plaintiff_ids.split(',').map(id => id.trim());
                    const defendantIds = result.caseData.defendant_ids ? result.caseData.defendant_ids.split(',').map(id => id.trim()) : [];
                    
                    // Fetch user details for plaintiffs and defendants
                    const plaintiffs = [];
                    const defendants = [];
                    
                    for (const id of plaintiffIds) {
                        try {
                            const user = await client.users.fetch(id);
                            plaintiffs.push(user.username);
                        } catch (e) {
                            plaintiffs.push(`User ${id}`);
                        }
                    }
                    
                    for (const id of defendantIds) {
                        try {
                            const user = await client.users.fetch(id);
                            defendants.push(user.username);
                        } catch (e) {
                            defendants.push(`User ${id}`);
                        }
                    }
                    
                    // Format case title
                    if (defendants.length === 0) {
                        caseTitle = `In Re: ${plaintiffs.join(', ')}`;
                    } else {
                        caseTitle = `${plaintiffs.join(', ')} v. ${defendants.join(', ')}`;
                    }
                }
                
                // Add field for this case
                searchEmbed.addFields({
                    name: `${result.caseCode}`,
                    value: `**${caseTitle}**\nChannel: <#${result.channelId}>\nMatch: "${result.matchedMessage}"\n[Jump to message](${result.messageUrl})`,
                    inline: false
                });
            }
            
            await interaction.editReply({
                embeds: [searchEmbed]
            });
            
        } catch (error) {
            console.error('Error searching closed cases:', error);
            await interaction.editReply({ 
                content: 'An error occurred while searching closed cases.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'dcsession') {
        await interaction.deferReply();
        
        const DUTY_COURT_CHANNEL_ID = '1392752972899024896';
        
        if (interaction.channel.id !== DUTY_COURT_CHANNEL_ID) {
            await interaction.editReply({
                content: 'This command can only be used in the duty court channel.',
                flags: 64
            });
            return;
        }
        
        const judge = interaction.options.getUser('judge');
        const partiesString = interaction.options.getString('parties');
        
        try {
            // Helper function to parse both mentions and regular usernames
            const parseUserInput = async (inputString) => {
                if (!inputString) return { userIds: [], usernames: [] };
                
                const userIds = [];
                const usernames = [];
                const tokens = inputString.split(/\s+/);
                
                for (const token of tokens) {
                    // Check if it's a mention
                    const mentionMatch = token.match(/<@!?(\d+)>/);
                    if (mentionMatch) {
                        userIds.push(mentionMatch[1]);
                    } else if (token.trim()) {
                        // Treat as username - try to find user by username
                        try {
                            const members = await interaction.guild.members.fetch({ query: token, limit: 100 });
                            const exactMatch = members.find(member => 
                                member.user.username.toLowerCase() === token.toLowerCase() ||
                                member.displayName.toLowerCase() === token.toLowerCase()
                            );
                            
                            if (exactMatch) {
                                userIds.push(exactMatch.id);
                            } else {
                                // If no Discord user found, store as plain username
                                usernames.push(token);
                            }
                        } catch (error) {
                            // If fetch fails, store as plain username
                            usernames.push(token);
                        }
                    }
                }
                
                return { userIds, usernames };
            };
            
            // Parse parties
            const partyResult = await parseUserInput(partiesString);
            const partyIds = partyResult.userIds;
            const partyUsernames = partyResult.usernames;
            
            if (partyIds.length === 0 && partyUsernames.length === 0) {
                await interaction.editReply({
                    content: 'Please provide at least one party (using @mention or username).',
                    flags: 64
                });
                return;
            }
            
            // Get next DC code
            const dcCode = await getNextDCCode(interaction.guildId);
            
            // Store in database
            const partiesForDb = [...partyIds, ...partyUsernames].join(',');
            await createDutyCourt(interaction.guildId, dcCode, judge.id, partiesForDb);
            
            // Update channel permissions - add speak permissions for judge and parties
            const channel = interaction.channel;
            
            // Add judge permissions
            await channel.permissionOverwrites.edit(judge.id, {
                ViewChannel: true,
                SendMessages: true
            });
            
            // Add permissions for all parties
            for (const partyId of partyIds) {
                try {
                    await channel.permissionOverwrites.edit(partyId, {
                        ViewChannel: true,
                        SendMessages: true
                    });
                } catch (error) {
                    console.error(`Error adding permissions for party ${partyId}:`, error);
                }
            }
            
            // Create party display strings
            const partyMentions = partyIds.map(id => `<@${id}>`);
            const allParties = [...partyMentions, ...partyUsernames];
            const partiesDisplay = allParties.join(', ');
            
            // Create session embed
            const sessionEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('⚖️ DUTY COURT SESSION INITIALIZED')
                .setDescription(`Duty Court session **${dcCode}** has been initialized.`)
                .addFields(
                    { name: 'Session Code', value: dcCode, inline: true },
                    { name: 'Presiding Judge', value: `<@${judge.id}>`, inline: true },
                    { name: 'Parties', value: partiesDisplay, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Court is now in session' });
            
            const sessionMessage = await interaction.editReply({ embeds: [sessionEmbed], fetchReply: true });
            
            // Update the session with the start message ID
            await updateDutyCourtSessionStart(interaction.guildId, dcCode, sessionMessage.id);
            
        } catch (error) {
            console.error('Error initializing duty court session:', error);
            await interaction.editReply({ 
                content: 'An error occurred while initializing the duty court session.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'dcadjourn') {
        await interaction.deferReply();
        
        const DUTY_COURT_CHANNEL_ID = '1392752972899024896';
        
        if (interaction.channel.id !== DUTY_COURT_CHANNEL_ID) {
            await interaction.editReply({
                content: 'This command can only be used in the duty court channel.',
                flags: 64
            });
            return;
        }
        
        try {
            // Get active duty court session
            const activeDC = await getActiveDutyCourt(interaction.guildId);
            
            if (!activeDC) {
                await interaction.editReply({
                    content: 'No active duty court session found.',
                    flags: 64
                });
                return;
            }
            
            // Parse party IDs from database
            const partyIds = activeDC.party_ids.split(',').filter(id => id && !id.includes('#') && /^\d+$/.test(id));
            
            const channel = interaction.channel;
            
            // Fetch messages from the session start to now
            let allMessages = [];
            let lastMessageId = null;
            let foundStartMessage = false;
            
            // Fetch messages in batches until we find the session start message
            while (!foundStartMessage) {
                const options = { limit: 100 };
                if (lastMessageId) {
                    options.before = lastMessageId;
                }
                
                const messages = await channel.messages.fetch(options);
                
                if (messages.size === 0) break;
                
                for (const [messageId, message] of messages) {
                    if (messageId === activeDC.session_start_message_id) {
                        foundStartMessage = true;
                        allMessages.push(message);
                        break;
                    }
                    allMessages.push(message);
                }
                
                lastMessageId = messages.last().id;
            }
            
            // Reverse to get chronological order
            allMessages.reverse();
            
            // Generate HTML transcript
            const transcriptHtml = generateDutyCourtTranscript(channel, allMessages, activeDC);
            
            // Create transcript file with simplified name
            const filename = `${activeDC.dc_code}_transcript.html`;
            const buffer = Buffer.from(transcriptHtml, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: filename });
            
            // Send transcript to the designated channel
            const TRANSCRIPT_CHANNEL_ID = '1392761390892322896';
            try {
                const transcriptChannel = await interaction.guild.channels.fetch(TRANSCRIPT_CHANNEL_ID);
                if (transcriptChannel) {
                    const transcriptEmbed = new EmbedBuilder()
                        .setColor(0x0099FF)
                        .setTitle('📄 Duty Court Transcript')
                        .setDescription(`Transcript for Duty Court Session **${activeDC.dc_code}**`)
                        .addFields(
                            { name: 'Session Date', value: new Date().toLocaleDateString(), inline: true },
                            { name: 'Presiding Judge', value: `<@${activeDC.judge_id}>`, inline: true }
                        )
                        .setTimestamp();
                    
                    await transcriptChannel.send({
                        embeds: [transcriptEmbed],
                        files: [attachment]
                    });
                }
            } catch (error) {
                console.error('Error sending transcript to designated channel:', error);
            }
            
            // Remove ALL permissions for judge and parties
            await channel.permissionOverwrites.delete(activeDC.judge_id);
            
            // Remove permissions for all parties
            for (const partyId of partyIds) {
                try {
                    await channel.permissionOverwrites.delete(partyId);
                } catch (error) {
                    console.error(`Error removing permissions for party ${partyId}:`, error);
                }
            }
            
            // Update database
            await adjournDutyCourt(interaction.guildId, activeDC.dc_code);
            
            // Create adjourn embed
            const adjournEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚖️ DUTY COURT SESSION ADJOURNED')
                .setDescription(`Duty Court session **${activeDC.dc_code}** has been adjourned.`)
                .addFields(
                    { name: 'Session Code', value: activeDC.dc_code, inline: true },
                    { name: 'Adjourned By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Adjourned At', value: new Date().toLocaleString(), inline: true },
                    { name: 'Transcript', value: 'Transcript has been filed', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Court is now adjourned - all permissions removed' });
            
            await interaction.editReply({ 
                embeds: [adjournEmbed]
            });
            
            // Delete all messages in the duty court channel
            try {
                let messagesToDelete;
                do {
                    messagesToDelete = await channel.messages.fetch({ limit: 100 });
                    
                    // Filter out messages older than 14 days (Discord limitation)
                    const deletableMessages = messagesToDelete.filter(msg => {
                        const messageAge = Date.now() - msg.createdTimestamp;
                        return messageAge < 14 * 24 * 60 * 60 * 1000; // 14 days in milliseconds
                    });
                    
                    if (deletableMessages.size > 0) {
                        if (deletableMessages.size === 1) {
                            await deletableMessages.first().delete();
                        } else {
                            await channel.bulkDelete(deletableMessages);
                        }
                    }
                    
                    // If there are old messages we can't delete, break the loop
                    if (messagesToDelete.size > deletableMessages.size) {
                        break;
                    }
                    
                } while (messagesToDelete.size === 100);
                
            } catch (error) {
                console.error('Error deleting messages in duty court channel:', error);
            }
            
        } catch (error) {
            console.error('Error adjourning duty court session:', error);
            await interaction.editReply({ 
                content: 'An error occurred while adjourning the duty court session.', 
                flags: 64 
            });
        }
    }
    
    if (interaction.commandName === 'dcminuteorder') {
        const DUTY_COURT_CHANNEL_ID = '1392752972899024896';
        
        if (interaction.channel.id !== DUTY_COURT_CHANNEL_ID) {
            await interaction.reply({
                content: 'This command can only be used in the duty court channel.',
                flags: 64
            });
            return;
        }
        
        const orderText = interaction.options.getString('order');
        
        try {
            // Get active duty court session
            const activeDC = await getActiveDutyCourt(interaction.guildId);
            
            if (!activeDC) {
                await interaction.reply({
                    content: 'No active duty court session found.',
                    flags: 64
                });
                return;
            }
            
            // Create minute order embed
            const minuteOrderEmbed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle('📝 DUTY COURT MINUTE ORDER')
                .setDescription(`**Session ${activeDC.dc_code}**`)
                .addFields(
                    { name: 'Order', value: orderText, inline: false },
                    { name: 'Issued By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Date/Time', value: new Date().toLocaleString(), inline: true }
                )
                .setTimestamp()
                .setFooter({ text: `Duty Court Session ${activeDC.dc_code}` });
            
            await interaction.reply({ embeds: [minuteOrderEmbed] });
            
        } catch (error) {
            console.error('Error issuing duty court minute order:', error);
            await interaction.reply({ 
                content: 'An error occurred while issuing the minute order.', 
                flags: 64 
            });
        }
    }
});

function generateDutyCourtTranscript(channel, messages, sessionData) {
    const escapeHtml = (text) => {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    };
    
    const formatTimestamp = (timestamp) => {
        return new Date(timestamp).toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    };
    
    const formatMessage = (message) => {
        let content = escapeHtml(message.content || '');
        
        // Convert Discord mentions to readable format
        content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
            const user = message.mentions.users.get(userId);
            return user ? `@${escapeHtml(user.username)}` : match;
        });
        
        // Convert channel mentions
        content = content.replace(/<#(\d+)>/g, (match, channelId) => {
            const channel = message.mentions.channels.get(channelId);
            return channel ? `#${escapeHtml(channel.name)}` : match;
        });
        
        // Convert role mentions
        content = content.replace(/<@&(\d+)>/g, (match, roleId) => {
            const role = message.mentions.roles.get(roleId);
            return role ? `@${escapeHtml(role.name)}` : match;
        });
        
        // Convert newlines to <br>
        content = content.replace(/\n/g, '<br>');
        
        return content;
    };
    
    const messagesHtml = messages.map(message => {
        const author = message.author;
        const isBot = author.bot ? ' [BOT]' : '';
        const attachments = message.attachments.size > 0 
            ? `<div class="attachments">📎 ${message.attachments.size} attachment(s)</div>` 
            : '';
        const embeds = message.embeds.length > 0
            ? message.embeds.map(embed => {
                let embedHtml = '<div class="embed">';
                if (embed.title) embedHtml += `<div class="embed-title">${escapeHtml(embed.title)}</div>`;
                if (embed.description) embedHtml += `<div class="embed-description">${escapeHtml(embed.description)}</div>`;
                if (embed.fields && embed.fields.length > 0) {
                    embedHtml += '<div class="embed-fields">';
                    embed.fields.forEach(field => {
                        embedHtml += `<div class="embed-field">`;
                        embedHtml += `<div class="field-name">${escapeHtml(field.name)}</div>`;
                        embedHtml += `<div class="field-value">${escapeHtml(field.value)}</div>`;
                        embedHtml += '</div>';
                    });
                    embedHtml += '</div>';
                }
                embedHtml += '</div>';
                return embedHtml;
            }).join('')
            : '';
        
        return `
            <div class="message">
                <div class="message-header">
                    <span class="timestamp">[${formatTimestamp(message.createdTimestamp)}]</span>
                    <span class="author">${escapeHtml(author.username)}${isBot}:</span>
                </div>
                <div class="message-content">${formatMessage(message)}</div>
                ${attachments}
                ${embeds}
            </div>
        `;
    }).join('');
    
    const sessionStart = new Date(sessionData.created_at);
    const sessionEnd = new Date();
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Duty Court Transcript - ${sessionData.dc_code}</title>
    <style>
        @media print {
            body {
                background-color: white !important;
                color: black !important;
            }
            .container {
                box-shadow: none !important;
            }
        }
        
        body {
            font-family: 'Times New Roman', Times, serif;
            background-color: #f5f5f5;
            color: #000;
            margin: 0;
            padding: 20px;
            line-height: 1.6;
        }
        .container {
            max-width: 8.5in;
            margin: 0 auto;
            background-color: white;
            padding: 1in;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            border-bottom: 2px solid #000;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        .header h1 {
            margin: 0;
            font-size: 24px;
            text-transform: uppercase;
        }
        .header h2 {
            margin: 10px 0 0 0;
            font-size: 18px;
            font-weight: normal;
        }
        .case-info {
            margin-bottom: 30px;
        }
        .case-info table {
            width: 100%;
            border-collapse: collapse;
        }
        .case-info td {
            padding: 5px 0;
            vertical-align: top;
        }
        .case-info .label {
            font-weight: bold;
            width: 150px;
        }
        .transcript-header {
            background-color: #f0f0f0;
            padding: 10px;
            margin: 20px 0;
            border: 1px solid #ccc;
            font-weight: bold;
            text-align: center;
        }
        .message {
            margin-bottom: 15px;
            padding-left: 20px;
        }
        .message-header {
            font-weight: bold;
            margin-bottom: 5px;
        }
        .timestamp {
            color: #666;
            font-size: 0.9em;
        }
        .author {
            color: #000;
            margin-left: 10px;
        }
        .message-content {
            margin-left: 20px;
            padding-left: 10px;
            border-left: 2px solid #e0e0e0;
        }
        .attachments {
            margin-top: 5px;
            margin-left: 30px;
            font-style: italic;
            color: #666;
        }
        .embed {
            margin: 10px 0 10px 30px;
            padding: 10px;
            background-color: #f8f8f8;
            border-left: 4px solid #0099ff;
        }
        .embed-title {
            font-weight: bold;
            margin-bottom: 5px;
        }
        .embed-description {
            margin-bottom: 10px;
        }
        .embed-fields {
            margin-top: 10px;
        }
        .embed-field {
            margin-bottom: 8px;
        }
        .field-name {
            font-weight: bold;
            color: #666;
        }
        .field-value {
            margin-left: 10px;
        }
        .footer {
            margin-top: 50px;
            padding-top: 20px;
            border-top: 1px solid #ccc;
            text-align: center;
            font-size: 0.9em;
            color: #666;
        }
        .certification {
            margin-top: 50px;
            padding: 20px;
            border: 1px solid #000;
            background-color: #f9f9f9;
        }
        .certification h3 {
            margin-top: 0;
            text-align: center;
        }
        .signature-line {
            margin-top: 40px;
            border-bottom: 1px solid #000;
            width: 300px;
            margin-left: auto;
            margin-right: auto;
        }
        .signature-label {
            text-align: center;
            margin-top: 5px;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>RIDGEWAY COUNTY DISTRICT COURT</h1>
            <h2>OFFICIAL DUTY COURT TRANSCRIPT</h2>
        </div>
        
        <div class="case-info">
            <table>
                <tr>
                    <td class="label">Session Code:</td>
                    <td>${sessionData.dc_code}</td>
                </tr>
                <tr>
                    <td class="label">Session Start:</td>
                    <td>${formatTimestamp(sessionStart)}</td>
                </tr>
                <tr>
                    <td class="label">Session End:</td>
                    <td>${formatTimestamp(sessionEnd)}</td>
                </tr>
                <tr>
                    <td class="label">Total Messages:</td>
                    <td>${messages.length}</td>
                </tr>
            </table>
        </div>
        
        <div class="transcript-header">
            VERBATIM TRANSCRIPT OF PROCEEDINGS
        </div>
        
        <div class="messages">
            ${messagesHtml}
        </div>
        
        <div class="certification">
            <h3>CERTIFICATE OF TRANSCRIPT</h3>
            <p>I hereby certify that this transcript is a true and accurate record of the proceedings in Duty Court Session ${sessionData.dc_code} held in the Ridgeway County District Court.</p>
            <p>This transcript was automatically generated from the official court record system.</p>
            <div class="signature-line"></div>
            <div class="signature-label">Court Recording System</div>
        </div>
        
        <div class="footer">
            <p>This is an official court document. Any unauthorized alteration is prohibited.</p>
            <p>Generated on ${formatTimestamp(new Date())}</p>
        </div>
    </div>
</body>
</html>
    `;
}

function generateTranscriptHTML(channel, messages) {
    const escapeHtml = (text) => {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    };
    
    const formatTimestamp = (timestamp) => {
        return new Date(timestamp).toLocaleString();
    };
    
    const formatMessage = (message) => {
        let content = escapeHtml(message.content || '');
        
        // Convert Discord mentions to readable format
        content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
            const user = message.mentions.users.get(userId);
            return user ? `@${escapeHtml(user.username)}` : match;
        });
        
        // Convert channel mentions
        content = content.replace(/<#(\d+)>/g, (match, channelId) => {
            const channel = message.mentions.channels.get(channelId);
            return channel ? `#${escapeHtml(channel.name)}` : match;
        });
        
        // Convert role mentions
        content = content.replace(/<@&(\d+)>/g, (match, roleId) => {
            const role = message.mentions.roles.get(roleId);
            return role ? `@${escapeHtml(role.name)}` : match;
        });
        
        // Convert newlines to <br>
        content = content.replace(/\n/g, '<br>');
        
        return content;
    };
    
    const messagesHtml = messages.map(message => {
        const author = message.author;
        const isBot = author.bot ? ' (BOT)' : '';
        const attachments = message.attachments.size > 0 
            ? `<div class="attachments">📎 ${message.attachments.size} attachment(s)</div>` 
            : '';
        const embeds = message.embeds.length > 0
            ? message.embeds.map(embed => {
                let embedHtml = '<div class="embed">';
                if (embed.title) embedHtml += `<div class="embed-title">${escapeHtml(embed.title)}</div>`;
                if (embed.description) embedHtml += `<div class="embed-description">${escapeHtml(embed.description)}</div>`;
                if (embed.fields && embed.fields.length > 0) {
                    embedHtml += '<div class="embed-fields">';
                    embed.fields.forEach(field => {
                        embedHtml += `<div class="embed-field ${field.inline ? 'inline' : ''}">`;
                        embedHtml += `<div class="field-name">${escapeHtml(field.name)}</div>`;
                        embedHtml += `<div class="field-value">${escapeHtml(field.value)}</div>`;
                        embedHtml += '</div>';
                    });
                    embedHtml += '</div>';
                }
                embedHtml += '</div>';
                return embedHtml;
            }).join('')
            : '';
        
        return `
            <div class="message">
                <div class="message-header">
                    <span class="author">${escapeHtml(author.username)}${isBot}</span>
                    <span class="timestamp">${formatTimestamp(message.createdTimestamp)}</span>
                </div>
                <div class="message-content">${formatMessage(message)}</div>
                ${attachments}
                ${embeds}
            </div>
        `;
    }).join('');
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Transcript - ${escapeHtml(channel.name)}</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background-color: #36393f;
            color: #dcddde;
            margin: 0;
            padding: 20px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background-color: #2f3136;
            border-radius: 8px;
            padding: 20px;
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #202225;
        }
        .header h1 {
            margin: 0;
            color: #ffffff;
        }
        .header .channel-info {
            color: #b9bbbe;
            margin-top: 10px;
        }
        .message {
            margin-bottom: 20px;
            padding: 15px;
            background-color: #40444b;
            border-radius: 8px;
        }
        .message-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .author {
            font-weight: bold;
            color: #7289da;
        }
        .timestamp {
            color: #72767d;
            font-size: 0.875em;
        }
        .message-content {
            line-height: 1.5;
        }
        .attachments {
            margin-top: 8px;
            color: #7289da;
            font-size: 0.9em;
        }
        .embed {
            margin-top: 10px;
            padding: 12px;
            background-color: #2f3136;
            border-left: 4px solid #7289da;
            border-radius: 4px;
        }
        .embed-title {
            font-weight: bold;
            margin-bottom: 8px;
            color: #ffffff;
        }
        .embed-description {
            margin-bottom: 10px;
        }
        .embed-fields {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }
        .embed-field {
            flex: 1 1 300px;
        }
        .embed-field.inline {
            flex: 1 1 150px;
        }
        .field-name {
            font-weight: bold;
            margin-bottom: 4px;
            color: #b9bbbe;
        }
        .field-value {
            color: #dcddde;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Channel Transcript</h1>
            <div class="channel-info">
                <p>#${escapeHtml(channel.name)}</p>
                <p>Generated on ${formatTimestamp(Date.now())}</p>
                <p>Total messages: ${messages.length}</p>
            </div>
        </div>
        <div class="messages">
            ${messagesHtml}
        </div>
    </div>
</body>
</html>
    `;
}

async function checkExpiredDeadlines() {
    try {
        const expiredDeadlines = await getExpiredDeadlines();
        
        for (const deadline of expiredDeadlines) {
            try {
                const channel = await client.channels.fetch(deadline.channel_id);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFFFF00)
                        .setTitle('⚠️ Discovery Deadline Expired')
                        .setDescription(`The ${deadline.case_type} discovery deadline has expired.`)
                        .addFields(
                            { name: 'Case Type', value: deadline.case_type.charAt(0).toUpperCase() + deadline.case_type.slice(1), inline: true },
                            { name: 'Set on', value: new Date(deadline.created_at).toLocaleString(), inline: true },
                            { name: 'Expired at', value: new Date(deadline.deadline).toLocaleString(), inline: false }
                        )
                        .setTimestamp();
                    
                    await channel.send({ content: `<@${deadline.user_id}>`, embeds: [embed] });
                    await markAsNotified(deadline.id);
                }
            } catch (channelError) {
                // Channel doesn't exist or bot doesn't have access
                console.error(`Failed to send discovery deadline notification for deadline ${deadline.id} in channel ${deadline.channel_id}:`, channelError.message);
                // Mark as notified anyway to prevent repeated attempts
                await markAsNotified(deadline.id);
            }
        }
    } catch (error) {
        console.error('Error checking expired deadlines:', error);
    }
}

function generateFinancialDisclosureHTML(username, caseCode, data) {
    const {
        bankBalance,
        cashBalance,
        vehiclesInput,
        vehicleValue,
        debts,
        ownsHome,
        totalAssets,
        netWorth,
        eligibility,
        eligibilityText
    } = data;
    
    const eligibilityColor = eligibility === 'eligible' ? '#00FF00' : 
                            eligibility === 'discretionary' ? '#FFA500' : '#FF0000';
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Financial Disclosure - ${caseCode}</title>
    <style>
        @page {
            size: letter;
            margin: 0.5in;
        }
        body {
            font-family: 'Times New Roman', Times, serif;
            line-height: 1.6;
            color: #000;
            background: #fff;
            margin: 0;
            padding: 20px;
        }
        .document {
            max-width: 8.5in;
            margin: 0 auto;
            padding: 1in;
            background: white;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
            border-bottom: 3px double #000;
            padding-bottom: 20px;
        }
        .court-name {
            font-size: 18px;
            font-weight: bold;
            text-transform: uppercase;
            margin-bottom: 10px;
        }
        .document-title {
            font-size: 24px;
            font-weight: bold;
            margin: 20px 0;
            text-transform: uppercase;
        }
        .case-info {
            font-size: 14px;
            margin-top: 10px;
        }
        .section {
            margin: 30px 0;
        }
        .section-title {
            font-size: 16px;
            font-weight: bold;
            text-transform: uppercase;
            border-bottom: 2px solid #000;
            padding-bottom: 5px;
            margin-bottom: 15px;
        }
        .disclosure-item {
            margin: 10px 0;
            display: flex;
            justify-content: space-between;
            padding: 5px 0;
            border-bottom: 1px dotted #ccc;
        }
        .label {
            font-weight: bold;
            flex: 1;
        }
        .value {
            flex: 1;
            text-align: right;
        }
        .summary {
            margin-top: 30px;
            padding: 20px;
            background: #f5f5f5;
            border: 2px solid #000;
        }
        .eligibility {
            margin-top: 30px;
            padding: 20px;
            text-align: center;
            font-size: 18px;
            font-weight: bold;
            background: ${eligibilityColor}33;
            border: 3px solid ${eligibilityColor};
            color: ${eligibility === 'eligible' ? '#008800' : eligibility === 'discretionary' ? '#CC7700' : '#CC0000'};
        }
        .certification {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 2px solid #000;
            font-size: 12px;
            line-height: 1.8;
        }
        .signature-line {
            margin-top: 40px;
            border-bottom: 1px solid #000;
            width: 300px;
        }
        .footer {
            margin-top: 50px;
            text-align: center;
            font-size: 10px;
            color: #666;
        }
        @media print {
            body {
                background: white;
            }
            .document {
                box-shadow: none;
                padding: 0;
            }
        }
    </style>
</head>
<body>
    <div class="document">
        <div class="header">
            <div class="court-name">Superior Court of Ridgeway</div>
            <div class="document-title">Financial Disclosure Affidavit</div>
            <div class="document-title">For Determination of Eligibility</div>
            <div class="document-title">For Court-Appointed Counsel</div>
            <div class="case-info">
                Case No: ${caseCode}<br>
                Date: ${new Date().toLocaleDateString()}<br>
                Time: ${new Date().toLocaleTimeString()}
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">Affiant Information</div>
            <div class="disclosure-item">
                <span class="label">Discord Username:</span>
                <span class="value">${username}</span>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">Financial Assets</div>
            <div class="disclosure-item">
                <span class="label">Bank Account Balance:</span>
                <span class="value">$${bankBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div class="disclosure-item">
                <span class="label">Cash on Hand:</span>
                <span class="value">$${cashBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div class="disclosure-item">
                <span class="label">Vehicle(s) Owned:</span>
                <span class="value">${vehiclesInput || 'None'}</span>
            </div>
            <div class="disclosure-item">
                <span class="label">Total Vehicle Value:</span>
                <span class="value">$${vehicleValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div class="disclosure-item">
                <span class="label">Homeownership Status:</span>
                <span class="value">${ownsHome ? 'Owns Residence' : 'Rents/No Home Ownership'}</span>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">Financial Liabilities</div>
            <div class="disclosure-item">
                <span class="label">Total Outstanding Debts:</span>
                <span class="value">$${debts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
        </div>
        
        <div class="summary">
            <div class="section-title">Financial Summary</div>
            <div class="disclosure-item">
                <span class="label">Total Assets:</span>
                <span class="value">$${totalAssets.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div class="disclosure-item">
                <span class="label">Total Liabilities:</span>
                <span class="value">$${debts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div class="disclosure-item" style="font-weight: bold; font-size: 16px; border-top: 2px solid #000; padding-top: 10px;">
                <span class="label">NET WORTH:</span>
                <span class="value">$${netWorth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
        </div>
        
        <div class="eligibility">
            ELIGIBILITY DETERMINATION<br>
            ${eligibilityText.toUpperCase()}
        </div>
        
        <div class="certification">
            <strong>CERTIFICATION UNDER PENALTY OF PERJURY</strong><br><br>
            I, the undersigned, hereby certify under penalty of perjury that the information provided in this financial disclosure affidavit is true, complete, and accurate to the best of my knowledge and belief. I understand that any false statements made herein may result in criminal prosecution for perjury and/or contempt of court, and may affect my eligibility for court-appointed counsel.
            <br><br>
            I further acknowledge that the Court may verify the information provided and that I have a continuing duty to inform the Court of any material changes to my financial circumstances during the pendency of this case.
            <br><br>
            Executed on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}.
            
            <div class="signature-line"></div>
            <div style="margin-top: 5px;">Digital Signature: ${username}</div>
        </div>
        
        <div class="footer">
            This document was generated electronically by the Ridgeway Court System<br>
            Document ID: FD-${caseCode}-${Date.now()}<br>
            For verification, contact the Clerk of Court
        </div>
    </div>
</body>
</html>
    `;
}

async function checkExpiredAppealDeadlines() {
    try {
        const expiredAppealDeadlines = await getExpiredAppealDeadlines();
        
        for (const deadline of expiredAppealDeadlines) {
            try {
                const channel = await client.channels.fetch(deadline.channel_id);
                if (channel) {
                    // Remove access for plaintiff and defendant
                    try {
                        await channel.permissionOverwrites.delete(deadline.plaintiff_id);
                    } catch (err) {
                        console.error(`Failed to remove plaintiff ${deadline.plaintiff_id} access:`, err.message);
                    }
                    
                    try {
                        await channel.permissionOverwrites.delete(deadline.defendant_id);
                    } catch (err) {
                        console.error(`Failed to remove defendant ${deadline.defendant_id} access:`, err.message);
                    }
                    
                    // Send notification
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('⚖️ Appeal Notice Period Expired')
                        .setDescription('The 24-hour Notice of Appeal period has expired.')
                        .addFields(
                            { name: 'Result', value: 'Plaintiff and Defendant access has been removed from this channel.', inline: false },
                            { name: 'Note', value: 'Only the Judge and Clerk retain access to this case.', inline: false }
                        )
                        .setTimestamp();
                    
                    await channel.send({ embeds: [embed] });
                }
            } catch (channelError) {
                // Channel doesn't exist or bot doesn't have access
                console.error(`Failed to process appeal deadline for deadline ${deadline.id} in channel ${deadline.channel_id}:`, channelError.message);
            } finally {
                // Always mark as processed to prevent repeated attempts
                await removePartyAccess(deadline.id);
            }
        }
    } catch (error) {
        console.error('Error checking expired appeal deadlines:', error);
    }
}

async function generateERPOPDF(erpoOrder, targetUser, issuedBy, caseCode, deadline) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: 72,
                bottom: 72,
                left: 72,
                right: 72
            }
        });
        
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Header
        doc.fontSize(12).text('SUPERIOR COURT OF RIDGEWAY', { align: 'center' });
        doc.fontSize(10).text('County of Ridgeway', { align: 'center' });
        doc.moveDown();
        
        // Title
        doc.fontSize(16).font('Helvetica-Bold').text('EXTREME RISK PROTECTION ORDER', { align: 'center' });
        doc.fontSize(14).text('(MINUTE ORDER)', { align: 'center' });
        doc.moveDown();
        
        // Case Information
        doc.fontSize(11).font('Helvetica');
        doc.text(`Case Number: ${caseCode}`, { align: 'left' });
        doc.text(`Date Issued: ${new Date().toLocaleString()}`, { align: 'left' });
        doc.text(`Order ID: ERPO-${erpoOrder.id}`, { align: 'left' });
        doc.moveDown();
        
        // Parties
        doc.font('Helvetica-Bold').text('PARTIES:', { underline: true });
        doc.font('Helvetica');
        doc.text(`Subject of Order: ${targetUser.username} (ID: ${targetUser.id})`);
        doc.text(`Issued By: ${issuedBy.username} (ID: ${issuedBy.id})`);
        doc.moveDown();
        
        // The Order
        doc.font('Helvetica-Bold').fontSize(12).text('THE COURT HEREBY ORDERS:', { underline: true });
        doc.font('Helvetica').fontSize(11);
        doc.moveDown(0.5);
        
        doc.text('1. The above-named subject SHALL IMMEDIATELY surrender all firearms, ammunition, and firearms accessories in their possession, custody, or control.');
        doc.moveDown(0.5);
        
        doc.text('2. The subject has TWELVE (12) HOURS from service of this order to surrender all firearms to:');
        doc.text('   • Ridgeway County Sheriff\'s Office, OR', { indent: 20 });
        doc.text('   • A Bona Fide Peace Officer appointed by the court', { indent: 20 });
        doc.moveDown(0.5);
        
        doc.text('3. Upon surrender, the subject MUST complete a Firearms Relinquishment Form.');
        doc.moveDown(0.5);
        
        doc.text(`4. Compliance Deadline: ${deadline.toLocaleString()}`);
        doc.moveDown();
        
        // Warning
        doc.font('Helvetica-Bold').text('WARNING:', { underline: true });
        doc.font('Helvetica').text('Failure to comply with this order may result in criminal prosecution and/or contempt of court proceedings.');
        doc.moveDown();
        
        // Legal Authority
        doc.font('Helvetica-Bold').text('LEGAL AUTHORITY:', { underline: true });
        doc.font('Helvetica').text('This order is issued pursuant to the Extreme Risk Protection Order Act of Ridgeway County.');
        doc.moveDown(2);
        
        // Signature Lines
        doc.text('_________________________________', { align: 'center' });
        doc.text('Judicial Officer', { align: 'center' });
        doc.moveDown();
        
        doc.text('_________________________________', { align: 'center' });
        doc.text('Date and Time', { align: 'center' });
        doc.moveDown(2);
        
        // Footer
        doc.fontSize(9).text('This is an official court document. Any alteration or falsification is a criminal offense.', { align: 'center' });
        doc.text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
        
        doc.end();
    });
}

async function generateFirearmsRelinquishmentPDF(user, caseCode, data) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: 72,
                bottom: 72,
                left: 72,
                right: 72
            }
        });
        
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Header
        doc.fontSize(12).text('SUPERIOR COURT OF RIDGEWAY', { align: 'center' });
        doc.fontSize(10).text('County of Ridgeway', { align: 'center' });
        doc.moveDown();
        
        // Title
        doc.fontSize(16).font('Helvetica-Bold').text('FIREARMS RELINQUISHMENT FORM', { align: 'center' });
        doc.moveDown();
        
        // Emergency Notice if applicable
        if (data.emergencyNotice) {
            doc.fillColor('red').fontSize(14).font('Helvetica-Bold')
                .text('*** EMERGENCY NOTICE TO COURT ***', { align: 'center' });
            doc.fillColor('black').font('Helvetica').fontSize(11);
            doc.moveDown();
        }
        
        // Case Information
        doc.fontSize(11).font('Helvetica');
        doc.text(`Case Number: ${caseCode}`, { align: 'left' });
        doc.text(`Date Filed: ${new Date().toLocaleString()}`, { align: 'left' });
        doc.text(`Form ID: FR-${Date.now()}`, { align: 'left' });
        doc.moveDown();
        
        // Declarant Information
        doc.font('Helvetica-Bold').text('DECLARANT:', { underline: true });
        doc.font('Helvetica');
        doc.text(`Name: ${user.username}`);
        doc.text(`Discord ID: ${user.id}`);
        doc.moveDown();
        
        // Declaration
        doc.font('Helvetica-Bold').fontSize(12).text('DECLARATION UNDER PENALTY OF PERJURY:', { underline: true });
        doc.font('Helvetica').fontSize(11);
        doc.moveDown(0.5);
        
        doc.text('I, the undersigned, declare under penalty of perjury that:');
        doc.moveDown(0.5);
        
        // Work Firearms
        doc.text(`1. ${data.workFirearms ? 'I DO' : 'I DO NOT'} possess firearms for the nature of my work.`);
        doc.moveDown(0.5);
        
        // Firearms Owned
        doc.text('2. Firearms in my possession, custody, or control:');
        doc.text(`   ${data.firearmsOwned || 'NONE'}`, { indent: 20 });
        doc.moveDown(0.5);
        
        // Ammunition Owned
        doc.text('3. Ammunition in my possession, custody, or control:');
        doc.text(`   ${data.ammunitionOwned || 'NONE'}`, { indent: 20 });
        doc.moveDown(0.5);
        
        // Surrender Status
        doc.text(`4. ${data.surrenderedAll ? 'I HAVE' : 'I HAVE NOT'} surrendered all firearms in my possession to the Ridgeway County Sheriff's Office.`);
        if (!data.surrenderedAll) {
            doc.fillColor('red').font('Helvetica-Bold').text('   *** NON-COMPLIANT ***', { indent: 20 });
            doc.fillColor('black').font('Helvetica');
        }
        doc.moveDown(0.5);
        
        // Understanding of Prohibition
        doc.text(`5. ${data.understandProhibition ? 'I UNDERSTAND' : 'I DO NOT UNDERSTAND'} that I am prohibited from acquiring a Ridgeway Firearms Identification License or Automatic Firearms License.`);
        if (!data.understandProhibition) {
            doc.fillColor('red').font('Helvetica-Bold').text('   *** REQUIRES CLARIFICATION ***', { indent: 20 });
            doc.fillColor('black').font('Helvetica');
        }
        doc.moveDown();
        
        // Legal Notice
        doc.font('Helvetica-Bold').text('LEGAL NOTICE:', { underline: true });
        doc.font('Helvetica').text('All firearms listed herein are seized pending resolution of the active court matter. Any attempt to acquire, possess, or control firearms in violation of this order may result in criminal prosecution.');
        doc.moveDown();
        
        // Compliance Status
        if (data.emergencyNotice) {
            doc.fillColor('red').font('Helvetica-Bold').fontSize(12).text('COMPLIANCE STATUS: NON-COMPLIANT', { underline: true });
            doc.font('Helvetica').fontSize(11);
            doc.text('Immediate judicial intervention required. Party has indicated:');
            if (!data.surrenderedAll) doc.text('• Failure to surrender all firearms');
            if (!data.understandProhibition) doc.text('• Lack of understanding regarding firearms prohibition');
            doc.fillColor('black');
        } else {
            doc.fillColor('green').font('Helvetica-Bold').fontSize(12).text('COMPLIANCE STATUS: COMPLIANT', { underline: true });
            doc.font('Helvetica').fontSize(11);
            doc.text('Party has confirmed full compliance with all requirements.');
            doc.fillColor('black');
        }
        doc.moveDown(2);
        
        // Certification
        doc.font('Helvetica-Bold').text('CERTIFICATION:', { underline: true });
        doc.font('Helvetica').text('I declare under penalty of perjury under the laws of Ridgeway that the foregoing is true and correct.');
        doc.moveDown();
        
        doc.text(`Executed on: ${new Date().toLocaleDateString()}`);
        doc.text(`At: ${new Date().toLocaleTimeString()}`);
        doc.moveDown(2);
        
        // Digital Signature
        doc.text('_________________________________');
        doc.text(`Digital Signature: ${user.username}`);
        doc.moveDown(3);
        
        // Footer
        doc.fontSize(9).text('This is an official court document. Any alteration or falsification is a criminal offense.', { align: 'center' });
        doc.text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
        
        doc.end();
    });
}

async function generateEmploymentProtectionOrder(user, caseCode) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: 72,
                bottom: 72,
                left: 72,
                right: 72
            }
        });
        
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Header
        doc.fontSize(12).text('SUPERIOR COURT OF RIDGEWAY', { align: 'center' });
        doc.fontSize(10).text('County of Ridgeway', { align: 'center' });
        doc.moveDown();
        
        // Title
        doc.fontSize(16).font('Helvetica-Bold').text('EMPLOYMENT PROTECTION ORDER', { align: 'center' });
        doc.fontSize(14).text('(MINUTE ORDER)', { align: 'center' });
        doc.moveDown();
        
        // Case Information
        doc.fontSize(11).font('Helvetica');
        doc.text(`Case Number: ${caseCode}`, { align: 'left' });
        doc.text(`Date Issued: ${new Date().toLocaleString()}`, { align: 'left' });
        doc.text(`Order ID: EPO-${Date.now()}`, { align: 'left' });
        doc.moveDown();
        
        // Subject Information
        doc.font('Helvetica-Bold').text('SUBJECT OF ORDER:', { underline: true });
        doc.font('Helvetica');
        doc.text(`Name: ${user.username}`);
        doc.text(`Discord ID: ${user.id}`);
        doc.moveDown();
        
        // Court Findings
        doc.font('Helvetica-Bold').fontSize(12).text('COURT FINDINGS:', { underline: true });
        doc.font('Helvetica').fontSize(11);
        doc.text('The Court finds that the above-named individual has disclosed possession of firearms for the nature of their work, and is subject to firearms restrictions pending resolution of this matter.');
        doc.moveDown();
        
        // The Order
        doc.font('Helvetica-Bold').fontSize(12).text('THE COURT HEREBY ORDERS:', { underline: true });
        doc.font('Helvetica').fontSize(11);
        doc.moveDown(0.5);
        
        // Section 1: Mandatory Accommodations
        doc.font('Helvetica-Bold').text('1. MANDATORY EMPLOYMENT ACCOMMODATIONS');
        doc.font('Helvetica');
        doc.text('The employer of the above-named individual SHALL provide the following accommodations:');
        doc.moveDown(0.5);
        
        doc.text('a) Administrative Leave Option: Place employee on paid administrative leave with continuation of all benefits, OR', { indent: 20 });
        doc.moveDown(0.5);
        
        doc.text('b) Reassignment Option: Reassign employee to duties not requiring firearm access, with:', { indent: 20 });
        doc.text('• No reduction in pay, benefits, or seniority', { indent: 40 });
        doc.text('• Comparable position and responsibilities', { indent: 40 });
        doc.text('• Maintenance of all employment privileges', { indent: 40 });
        doc.moveDown();
        
        // Section 2: Prohibited Actions
        doc.font('Helvetica-Bold').text('2. PROHIBITED ACTIONS');
        doc.font('Helvetica');
        doc.text('The employer is PROHIBITED from:');
        doc.text('• Terminating employment based on firearm restrictions', { indent: 20 });
        doc.text('• Reducing compensation or benefits', { indent: 20 });
        doc.text('• Taking any adverse employment action', { indent: 20 });
        doc.text('• Discriminating or retaliating against the employee', { indent: 20 });
        doc.moveDown();
        
        // Section 3: Duration
        doc.font('Helvetica-Bold').text('3. DURATION');
        doc.font('Helvetica');
        doc.text('This Order shall remain in full force and effect until this case is fully resolved, including:');
        doc.text('• Final disposition of all charges', { indent: 20 });
        doc.text('• Completion of any appeals', { indent: 20 });
        doc.text('• Satisfaction of any sentence or probation', { indent: 20 });
        doc.text('• Final resolution of all related proceedings', { indent: 20 });
        doc.moveDown();
        
        // Enforcement
        doc.font('Helvetica-Bold').text('ENFORCEMENT:', { underline: true });
        doc.font('Helvetica').text('Violation of this Order may result in contempt of court proceedings and civil liability. This Order is enforceable by law enforcement and may be presented to employers as a lawful court mandate.');
        doc.moveDown(2);
        
        // Signature
        doc.text('IT IS SO ORDERED.', { align: 'center' });
        doc.moveDown();
        doc.text('_________________________________', { align: 'center' });
        doc.text('Judicial Officer', { align: 'center' });
        doc.moveDown();
        doc.text(`Date: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Footer
        doc.fontSize(9).text('This is an official court order. Any violation may result in criminal prosecution.', { align: 'center' });
        doc.text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
        
        doc.end();
    });
}

async function checkExpiredERPODeadlines() {
    try {
        const expiredOrders = await getExpiredERPOOrders();
        
        for (const order of expiredOrders) {
            try {
                const channel = await client.channels.fetch(order.channel_id);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('🚨 ERPO Deadline Expired')
                        .setDescription(`The 12-hour deadline for ERPO compliance has expired.`)
                        .addFields(
                            { name: 'Subject', value: `<@${order.target_user_id}>`, inline: true },
                            { name: 'Issued By', value: `<@${order.issued_by}>`, inline: true },
                            { name: 'Case', value: order.case_code, inline: true },
                            { name: 'Deadline Was', value: new Date(order.deadline).toLocaleString(), inline: false },
                            { name: 'Status', value: '⚠️ **NON-COMPLIANT** - Subject failed to surrender firearms within the required timeframe.', inline: false },
                            { name: 'Next Steps', value: 'The court may initiate contempt proceedings or refer to law enforcement for criminal prosecution.', inline: false }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'Automatic notification of non-compliance' });
                    
                    await channel.send({ 
                        content: `<@${order.issued_by}> <@${order.target_user_id}>`, 
                        embeds: [embed] 
                    });
                    
                    // Mark this order as notified to prevent duplicate notifications
                    await markERPODeadlineNotified(order.id);
                }
            } catch (channelError) {
                // Channel doesn't exist or bot doesn't have access
                console.error(`Failed to send ERPO deadline notification for order ${order.id} in channel ${order.channel_id}:`, channelError.message);
                // Mark as notified anyway to prevent repeated attempts
                await markERPODeadlineNotified(order.id);
                // Continue processing other orders
            }
        }
    } catch (error) {
        console.error('Error checking expired ERPO deadlines:', error);
    }
}

async function generateMinuteOrderPDF(caseCode, orderId, targetParty, orderText, issuedBy, date) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: 72,
                bottom: 72,
                left: 72,
                right: 72
            }
        });
        
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Header
        doc.fontSize(12).text('SUPERIOR COURT OF RIDGEWAY', { align: 'center' });
        doc.fontSize(10).text('County of Ridgeway', { align: 'center' });
        doc.moveDown();
        
        // Title
        doc.fontSize(16).font('Helvetica-Bold').text('MINUTE ORDER', { align: 'center' });
        doc.moveDown();
        
        // Case Information
        doc.fontSize(11).font('Helvetica');
        doc.text(`Case Number: ${caseCode}`, { align: 'left' });
        doc.text(`Date Issued: ${date.toLocaleString()}`, { align: 'left' });
        doc.text(`Order ID: ${orderId}`, { align: 'left' });
        doc.moveDown();
        
        // Parties
        doc.font('Helvetica-Bold').text('PARTIES:', { underline: true });
        doc.font('Helvetica');
        doc.text(`Party Directed At: ${targetParty.username} (ID: ${targetParty.id})`);
        doc.text(`Issued By: ${issuedBy.username} (ID: ${issuedBy.id})`);
        doc.moveDown();
        
        // The Order
        doc.font('Helvetica-Bold').fontSize(12).text('THE COURT HEREBY ORDERS:', { underline: true });
        doc.font('Helvetica').fontSize(11);
        doc.moveDown(0.5);
        
        // Order text - handle line breaks and formatting
        const orderLines = orderText.split('\n');
        orderLines.forEach(line => {
            doc.text(line);
        });
        doc.moveDown();
        
        // Compliance Notice
        doc.font('Helvetica-Bold').text('NOTICE:', { underline: true });
        doc.font('Helvetica').text('The above-named party SHALL comply with this order immediately. Failure to comply may result in contempt of court proceedings.');
        doc.moveDown(2);
        
        // Signature Lines
        doc.text('IT IS SO ORDERED.', { align: 'center' });
        doc.moveDown();
        doc.text('_________________________________', { align: 'center' });
        doc.text('Judicial Officer', { align: 'center' });
        doc.moveDown();
        doc.text(`Date: ${date.toLocaleDateString()}`, { align: 'center' });
        doc.text(`Time: ${date.toLocaleTimeString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Footer
        doc.fontSize(9).text('This is an official court document. Any alteration or falsification is a criminal offense.', { align: 'center' });
        doc.text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
        
        doc.end();
    });
}

async function getRobloxUserAvatar(username) {
    try {
        // First, get user ID from username
        const userResponse = await axios.post('https://users.roblox.com/v1/usernames/users', {
            usernames: [username],
            excludeBannedUsers: false
        });
        
        if (!userResponse.data.data || userResponse.data.data.length === 0) {
            return null;
        }
        
        const userId = userResponse.data.data[0].id;
        
        // Get user's avatar headshot
        const avatarResponse = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`);
        
        if (!avatarResponse.data.data || avatarResponse.data.data.length === 0) {
            return null;
        }
        
        const imageUrl = avatarResponse.data.data[0].imageUrl;
        
        // Download the image
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        return Buffer.from(imageResponse.data);
        
    } catch (error) {
        console.error('Error fetching Roblox avatar:', error);
        return null;
    }
}

async function generateWantedPosterPDF(targetUsername, caseChannelName, issuedBy) {
    return new Promise(async (resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: 50,
                bottom: 50,
                left: 50,
                right: 50
            }
        });
        
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Border
        doc.rect(30, 30, doc.page.width - 60, doc.page.height - 60)
           .lineWidth(5)
           .stroke('#8B4513');
        
        // WANTED header
        doc.fontSize(72).font('Helvetica-Bold')
           .fillColor('#8B0000')
           .text('WANTED', 0, 80, { align: 'center', width: doc.page.width });
        
        // Subheader
        doc.fontSize(24).font('Helvetica-Bold')
           .fillColor('#000000')
           .text('BY ORDER OF THE COURT', 0, 170, { align: 'center', width: doc.page.width });
        
        // Photo area
        const photoX = (doc.page.width - 300) / 2;
        const photoY = 220;
        const photoSize = 300;
        
        // Try to get Roblox avatar
        const avatarBuffer = await getRobloxUserAvatar(targetUsername);
        
        if (avatarBuffer) {
            // Add the Roblox avatar image
            doc.image(avatarBuffer, photoX, photoY, { width: photoSize, height: photoSize });
            
            // Add border around image
            doc.rect(photoX, photoY, photoSize, photoSize)
               .lineWidth(2)
               .stroke('#000000');
        } else {
            // Photo placeholder if no avatar found
            doc.rect(photoX, photoY, photoSize, photoSize)
               .lineWidth(2)
               .stroke('#000000');
            
            doc.rect(photoX, photoY, photoSize, photoSize)
               .fill('#EEEEEE');
            
            doc.fontSize(24).font('Helvetica-Bold')
               .fillColor('#666666')
               .text('PHOTO', 0, 350, { align: 'center', width: doc.page.width });
            doc.text('UNAVAILABLE', 0, 380, { align: 'center', width: doc.page.width });
        }
        
        // Username
        doc.fontSize(36).font('Helvetica-Bold')
           .fillColor('#000000')
           .text(targetUsername, 0, 550, { align: 'center', width: doc.page.width });
        
        // Simplified warrant text
        doc.fontSize(20).font('Helvetica-Bold')
           .fillColor('#000000');
        
        const warrantY = 620;
        doc.text('A BENCH WARRANT HAS BEEN ISSUED', 0, warrantY, { align: 'center', width: doc.page.width });
        doc.text('BY THE SUPERIOR COURT', 0, warrantY + 30, { align: 'center', width: doc.page.width });
        
        doc.moveDown();
        doc.fontSize(18).font('Helvetica')
           .text(`CASE: ${caseChannelName}`, 0, warrantY + 80, { align: 'center', width: doc.page.width });
        
        doc.moveDown();
        doc.fontSize(22).font('Helvetica-Bold')
           .fillColor('#8B0000')
           .text('SURRENDER TO LAW ENFORCEMENT', 0, warrantY + 130, { align: 'center', width: doc.page.width });
        doc.text('IMMEDIATELY', 0, warrantY + 160, { align: 'center', width: doc.page.width });
        
        // Footer
        doc.fontSize(12).font('Helvetica-Bold')
           .fillColor('#8B0000')
           .text('ALL LAW ENFORCEMENT OFFICERS AND CERTIFIED', 0, doc.page.height - 100, { align: 'center', width: doc.page.width });
        doc.text('BOUNTY AGENTS ARE COMMANDED TO ARREST', 0, doc.page.height - 80, { align: 'center', width: doc.page.width });
        
        // Issue info
        doc.fontSize(10).font('Helvetica')
           .fillColor('#666666')
           .text(`Issued by: ${issuedBy} | Date: ${new Date().toLocaleDateString()}`, 0, doc.page.height - 40, { align: 'center', width: doc.page.width });
        
        doc.end();
    });
}

async function generateNOAPDF(plaintiffNames, defendantNames, channelName, attorneyName, appearingFor, barNumber, date) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: {
                top: 72,
                bottom: 72,
                left: 72,
                right: 72
            }
        });
        
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Header
        doc.fontSize(12).font('Helvetica-Bold').text('IN THE SUPERIOR COURT OF THE STATE OF RIDGEWAY', { align: 'center' });
        doc.moveDown(2);
        
        // Left-aligned party section
        doc.fontSize(11).font('Helvetica');
        doc.text(plaintiffNames, 72, doc.y, { align: 'left' });
        doc.moveDown(0.5);
        doc.text('Plaintiff' + (plaintiffNames.includes(',') ? 's' : ''), { align: 'left', indent: 40 });
        doc.moveDown();
        
        doc.text('v.', { align: 'left' });
        doc.moveDown();
        
        doc.text(defendantNames, { align: 'left' });
        doc.moveDown(0.5);
        doc.text('Defendant' + (defendantNames.includes(',') ? 's' : ''), { align: 'left', indent: 40 });
        
        // Case number on the right
        doc.fontSize(11).text(')', 300, 120);
        doc.text(')', 300, 135);
        doc.text(')', 300, 150);
        doc.text(')', 300, 165);
        doc.text(')', 300, 180);
        doc.text(')', 300, 195);
        doc.text(')', 300, 210);
        doc.text(')', 300, 225);
        doc.text(')', 300, 240);
        doc.text(')', 300, 255);
        doc.text(`DOCKET NO. ${channelName.toUpperCase()}`, 330, 180);
        
        doc.moveDown(4);
        
        // Title
        doc.fontSize(14).font('Helvetica-Bold').text('NOTICE OF APPEARANCE', { align: 'center' });
        doc.moveDown(2);
        
        // Body
        doc.fontSize(11).font('Helvetica');
        const bodyText = `I, ${attorneyName}, am admitted or otherwise authorized to practice in this court, and I appear in the above-entitled matter as counsel of record for the ${appearingFor.charAt(0).toUpperCase() + appearingFor.slice(1)}. Please serve a copy of any and all pleadings filed in the above-entitled matter to the undersigned attorney.`;
        
        doc.text(bodyText, {
            align: 'left',
            lineGap: 5
        });
        
        doc.moveDown(3);
        
        // Closing
        doc.text('Respectfully Submitted,', { align: 'left' });
        doc.moveDown(2);
        
        // Signature line
        doc.text('_________________________________', { align: 'left' });
        doc.text(attorneyName, { align: 'left' });
        
        // Bar number overlay - positioned at top right of document
        doc.save();
        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor('#FF0000');
        doc.text(`Bar No. ${barNumber}`, 400, 50, { align: 'right' });
        doc.restore();
        
        // Footer with date
        doc.fontSize(9).font('Helvetica');
        doc.text(`Filed: ${date.toLocaleDateString()}`, 72, 720, { align: 'left' });
        doc.text(`Generated: ${new Date().toISOString()}`, 72, 732, { align: 'left' });
        
        doc.end();
    });
}

function generateStaffInvoiceReceipt(data) {
    const {
        invoiceNumber,
        date,
        userName,
        userId,
        caseId,
        roleDisplay,
        basePay,
        hours,
        hourlyRate,
        hourlyPay,
        reimbursements,
        receiptUrl,
        totalAmount
    } = data;
    
    const receiptDate = date.toLocaleDateString();
    const receiptTime = date.toLocaleTimeString();
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Staff Invoice - ${invoiceNumber}</title>
    <style>
        @page {
            size: 80mm 297mm;
            margin: 0;
        }
        body {
            font-family: 'Courier New', monospace;
            background: #f0f0f0;
            margin: 0;
            padding: 20px;
            font-size: 12px;
            line-height: 1.4;
        }
        .receipt {
            background: white;
            width: 300px;
            margin: 0 auto;
            padding: 20px;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
            border: 1px solid #ddd;
        }
        .header {
            text-align: center;
            border-bottom: 2px dashed #333;
            padding-bottom: 15px;
            margin-bottom: 15px;
        }
        .store-name {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 5px;
            letter-spacing: 2px;
        }
        .tagline {
            font-size: 10px;
            color: #666;
            margin-bottom: 10px;
        }
        .receipt-info {
            font-size: 10px;
            color: #666;
        }
        .section {
            margin: 15px 0;
            border-bottom: 1px dashed #ccc;
            padding-bottom: 10px;
        }
        .item-row {
            display: flex;
            justify-content: space-between;
            margin: 5px 0;
        }
        .item-name {
            flex: 1;
            text-align: left;
        }
        .item-price {
            text-align: right;
            min-width: 80px;
        }
        .subtotal {
            font-weight: bold;
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid #333;
        }
        .total {
            font-size: 16px;
            font-weight: bold;
            margin-top: 10px;
            padding-top: 10px;
            border-top: 2px solid #333;
            border-bottom: 2px solid #333;
            padding-bottom: 10px;
        }
        .footer {
            text-align: center;
            margin-top: 20px;
            font-size: 10px;
            color: #666;
        }
        .barcode {
            text-align: center;
            margin: 15px 0;
            font-family: 'Libre Barcode 128', monospace;
            font-size: 32px;
            letter-spacing: 3px;
        }
        .thank-you {
            text-align: center;
            font-size: 14px;
            font-weight: bold;
            margin-top: 20px;
        }
        @media print {
            body {
                background: white;
                padding: 0;
            }
            .receipt {
                box-shadow: none;
                border: none;
                width: 80mm;
            }
        }
    </style>
</head>
<body>
    <div class="receipt">
        <div class="header">
            <div class="store-name">RIDGEWAY COURT</div>
            <div class="tagline">PAYROLL DEPARTMENT</div>
            <div class="receipt-info">
                <div>${receiptDate} ${receiptTime}</div>
                <div>Invoice #: ${invoiceNumber}</div>
            </div>
        </div>
        
        <div class="section">
            <div class="item-row">
                <div class="item-name">Staff Member:</div>
                <div class="item-price">${userName}</div>
            </div>
            <div class="item-row">
                <div class="item-name">Staff ID:</div>
                <div class="item-price">${userId}</div>
            </div>
            <div class="item-row">
                <div class="item-name">Case ID:</div>
                <div class="item-price">${caseId}</div>
            </div>
            <div class="item-row">
                <div class="item-name">Role:</div>
                <div class="item-price">${roleDisplay}</div>
            </div>
        </div>
        
        <div class="section">
            <div class="item-row">
                <div class="item-name">BASE PAY</div>
                <div class="item-price">$${basePay.toFixed(2)}</div>
            </div>
            ${hours > 0 ? `
            <div class="item-row">
                <div class="item-name">HOURS WORKED</div>
                <div class="item-price">${hours.toFixed(2)}</div>
            </div>
            <div class="item-row">
                <div class="item-name">HOURLY RATE</div>
                <div class="item-price">$${hourlyRate.toFixed(2)}/hr</div>
            </div>
            <div class="item-row">
                <div class="item-name">HOURLY PAY</div>
                <div class="item-price">$${hourlyPay.toFixed(2)}</div>
            </div>
            ` : ''}
            ${reimbursements > 0 ? `
            <div class="item-row">
                <div class="item-name">REIMBURSEMENTS</div>
                <div class="item-price">$${reimbursements.toFixed(2)}</div>
            </div>
            ${receiptUrl ? `
            <div class="item-row" style="font-size: 10px;">
                <div class="item-name">Receipt: ${receiptUrl.substring(0, 30)}...</div>
            </div>
            ` : ''}
            ` : ''}
        </div>
        
        <div class="total item-row">
            <div class="item-name">TOTAL DUE</div>
            <div class="item-price">$${totalAmount.toFixed(2)}</div>
        </div>
        
        <div class="barcode">
            ||||| |||| | |||| ||||| ||| |||||
        </div>
        
        <div class="footer">
            <div>PAYROLL COPY</div>
            <div>KEEP FOR YOUR RECORDS</div>
            <div style="margin-top: 10px;">
                Questions? Contact Clerk of Superior Court<br>
                Reference: ${invoiceNumber}
            </div>
        </div>
        
        <div class="thank-you">
            THANK YOU FOR YOUR SERVICE
        </div>
    </div>
</body>
</html>
    `;
}

async function checkDEJCheckins() {
    try {
        const dueCheckins = await getDEJCheckinsDue();
        
        for (const dej of dueCheckins) {
            try {
                const channel = await client.channels.fetch(dej.channel_id);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFFFF00)
                        .setTitle('⚠️ PROBATION CHECK-IN REQUIRED')
                        .setDescription(`Probation check-in is now due.`)
                        .addFields(
                            { name: 'Probationer', value: `<@${dej.target_user_id}>`, inline: true },
                            { name: 'Case', value: dej.case_code, inline: true },
                            { name: 'Check-in #', value: (dej.checkin_count + 1).toString(), inline: true },
                            { name: 'Last Check-in', value: dej.last_checkin ? new Date(dej.last_checkin).toLocaleDateString() : 'Never', inline: true },
                            { name: 'Due Date', value: new Date(dej.next_checkin).toLocaleDateString(), inline: true },
                            { name: 'Status', value: '🔴 OVERDUE', inline: true },
                            { name: 'Required Action', value: `<@${dej.target_user_id}> must check in immediately with:\n• Confirmation of compliance with all conditions\n• Any issues or concerns\n• Progress updates`, inline: false }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'Failure to check in may result in probation violation' });
                    
                    await channel.send({ 
                        content: `<@${dej.target_user_id}> **PROBATION CHECK-IN REQUIRED**`, 
                        embeds: [embed] 
                    });
                    
                    // Update next check-in date
                    await updateDEJCheckin(dej.id);
                }
            } catch (channelError) {
                // Channel doesn't exist or bot doesn't have access
                console.error(`Failed to send DEJ check-in reminder for order ${dej.id} in channel ${dej.channel_id}:`, channelError.message);
                // Still update the check-in date to prevent spam
                await updateDEJCheckin(dej.id);
            }
        }
    } catch (error) {
        console.error('Error checking DEJ check-ins:', error);
    }
}

async function checkHearingReminders() {
    try {
        const upcomingHearings = await getUpcomingHearingReminders();
        
        for (const hearing of upcomingHearings) {
            try {
                const channel = await client.channels.fetch(hearing.channel_id);
                if (channel) {
                    const hearingDate = new Date(hearing.hearing_date);
                    const now = new Date();
                    const timeDiff = hearingDate - now;
                    const isOneHourReminder = timeDiff <= 60 * 60 * 1000 && timeDiff > 0 && !hearing.one_hour_reminder_sent;
                    const isStartReminder = timeDiff <= 0 && !hearing.start_reminder_sent;
                
                if (isOneHourReminder) {
                    // 1 hour reminder
                    const hearingMoment = moment.tz(hearingDate, hearing.timezone);
                    const embed = new EmbedBuilder()
                        .setColor(0xFFA500)
                        .setTitle('⚖️ HEARING REMINDER - 1 HOUR')
                        .setDescription(`Your hearing is scheduled to begin in 1 hour.`)
                        .addFields(
                            { name: 'Case', value: hearing.case_code, inline: true },
                            { name: 'Time', value: `${hearingMoment.format('h:mm A')} ${hearingMoment.format('z')}`, inline: true },
                            { name: 'Location', value: hearing.is_virtual ? `Virtual (${hearing.location})` : hearing.location, inline: true },
                            { name: 'Date', value: hearingMoment.format('MMMM D, YYYY'), inline: false }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'Please prepare for your hearing' });
                    
                    // Tag all parties
                    const partyIds = hearing.assigned_parties.split(',').filter(id => id.trim());
                    const partyTags = partyIds.map(id => `<@${id.trim()}>`).join(' ');
                    
                    await channel.send({ 
                        content: `${partyTags}\n**⏰ 1 HOUR HEARING REMINDER**`, 
                        embeds: [embed] 
                    });
                    
                    await markHearingReminderSent(hearing.id, 'one_hour');
                    
                } else if (isStartReminder) {
                    // Hearing start reminder
                    const hearingMoment = moment.tz(hearingDate, hearing.timezone);
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('⚖️ HEARING STARTING NOW')
                        .setDescription(`The scheduled hearing is starting now.`)
                        .addFields(
                            { name: 'Case', value: hearing.case_code, inline: true },
                            { name: 'Location', value: hearing.is_virtual ? `Virtual (${hearing.location})` : hearing.location, inline: true },
                            { name: 'Time', value: `${hearingMoment.format('h:mm A')} ${hearingMoment.format('z')}`, inline: true },
                            { name: 'Judge', value: `Please wait for the Judge to begin proceedings`, inline: false }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'All parties must be present' });
                    
                    // Tag all parties
                    const partyIds = hearing.assigned_parties.split(',').filter(id => id.trim());
                    const partyTags = partyIds.map(id => `<@${id.trim()}>`).join(' ');
                    
                    await channel.send({ 
                        content: `${partyTags}\n**🔴 HEARING STARTING NOW**`, 
                        embeds: [embed] 
                    });
                    
                    await markHearingReminderSent(hearing.id, 'start');
                }
            }
            } catch (channelError) {
                // Channel doesn't exist or bot doesn't have access
                console.error(`Failed to send hearing reminder for hearing ${hearing.id} in channel ${hearing.channel_id}:`, channelError.message);
                // Mark as sent anyway to prevent repeated attempts
                if (hearing.hearing_date - new Date() <= 60 * 60 * 1000 && !hearing.one_hour_reminder_sent) {
                    await markHearingReminderSent(hearing.id, 'one_hour');
                }
                if (hearing.hearing_date - new Date() <= 0 && !hearing.start_reminder_sent) {
                    await markHearingReminderSent(hearing.id, 'start');
                }
            }
        }
    } catch (error) {
        console.error('Error checking hearing reminders:', error);
    }
}

// Message Create Event Handler - Cache messages in active case channels
client.on(Events.MessageCreate, async message => {
    try {
        // Check if this channel has an active case
        const caseInfo = await getCaseByChannel(message.channel.id);
        
        if (caseInfo && caseInfo.status === 'active') {
            // Initialize channel cache if it doesn't exist
            if (!messageCache.has(message.channel.id)) {
                messageCache.set(message.channel.id, new Map());
            }
            
            const channelCache = messageCache.get(message.channel.id);
            
            // Store message data
            channelCache.set(message.id, {
                id: message.id,
                content: message.content,
                author: {
                    id: message.author.id,
                    username: message.author.username,
                    tag: message.author.tag
                },
                createdTimestamp: message.createdTimestamp,
                attachments: message.attachments.map(att => ({
                    name: att.name,
                    url: att.url
                })),
                embeds: message.embeds.map(embed => ({
                    title: embed.title,
                    description: embed.description
                }))
            });
            
            // Limit cache size by removing oldest messages
            if (channelCache.size > MAX_MESSAGES_PER_CHANNEL) {
                const oldestKey = channelCache.keys().next().value;
                channelCache.delete(oldestKey);
            }
        }
    } catch (error) {
        console.error('Error caching message:', error);
    }
});

// Message Delete Event Handler
client.on(Events.MessageDelete, async message => {
    try {
        // Check if this channel has an active case
        const caseInfo = await getCaseByChannel(message.channel.id);
        
        if (caseInfo && caseInfo.status === 'active') {
            let messageData = null;
            
            // First, try to get the message from our cache
            const channelCache = messageCache.get(message.channel.id);
            if (channelCache && channelCache.has(message.id)) {
                messageData = channelCache.get(message.id);
                // Remove from cache after retrieving
                channelCache.delete(message.id);
            }
            
            // If not in cache, try to use whatever Discord provides
            if (!messageData && !message.partial) {
                messageData = {
                    content: message.content,
                    author: {
                        id: message.author?.id,
                        username: message.author?.username,
                        tag: message.author?.tag
                    },
                    createdTimestamp: message.createdTimestamp
                };
            }
            
            // Prepare display values
            let messageContent = '[Message content not available]';
            let authorDisplay = '[Unknown user]';
            let authorName = 'Unknown';
            let createdTimestamp = null;
            
            if (messageData) {
                messageContent = messageData.content || '[Empty message]';
                if (messageData.author) {
                    authorDisplay = `<@${messageData.author.id}>`;
                    authorName = messageData.author.username || 'Unknown';
                }
                createdTimestamp = messageData.createdTimestamp;
            }
            
            // Create the deletion notification embed
            const deletionEmbed = new EmbedBuilder()
                .setColor(0xFFFF00) // Yellow color
                .setTitle('🔔 Record Modification Notice')
                .setDescription(`${authorName} has deleted a message`)
                .addFields(
                    { name: 'Deleted Message', value: messageContent.substring(0, 1024), inline: false },
                    { name: 'Author', value: authorDisplay, inline: true }
                );
            
            // Add timestamp fields if available
            if (createdTimestamp) {
                deletionEmbed.addFields({ name: 'Original Message Time', value: `<t:${Math.floor(createdTimestamp / 1000)}:F>`, inline: true });
            }
            
            deletionEmbed.addFields({ name: 'Deletion Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true });
            
            // Add attachment info if available
            if (messageData?.attachments && messageData.attachments.length > 0) {
                const attachmentList = messageData.attachments.map(att => `• ${att.name}`).join('\n');
                deletionEmbed.addFields({ name: 'Attachments', value: attachmentList.substring(0, 1024), inline: false });
            }
            
            deletionEmbed.setFooter({ text: 'Court transcript modification - unapproved' })
                .setTimestamp();
            
            // Send the notification to the same channel
            await message.channel.send({ embeds: [deletionEmbed] });
        }
    } catch (error) {
        console.error('Error handling message deletion:', error);
    }
});

client.login(process.env.DISCORD_TOKEN);