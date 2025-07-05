require('dotenv').config();
const { Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, AttachmentBuilder } = require('discord.js');
const { initializeDatabase, createDiscoveryDeadline, getExpiredDeadlines, markAsNotified, createCase, createGagOrder, updateGagOrderStatus, updateCaseStatus, getCaseByChannel, createAppealDeadline, getExpiredAppealDeadlines, removePartyAccess, fileAppealNotice, getActiveAppealDeadline, createAppealFiling, createFinancialDisclosure } = require('./database');
const fs = require('fs').promises;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
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
        .addUserOption(option =>
            option.setName('clerk')
                .setDescription('The assigned clerk')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('plaintiff')
                .setDescription('The plaintiff')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('defendant')
                .setDescription('The defendant')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('case_link')
                .setDescription('Link to the case details')
                .setRequired(true));
    
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
                .setDescription('List owned vehicles with estimated values (e.g., "2020 Honda Civic $15000, 2018 Toyota Camry $12000")')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('debts')
                .setDescription('Total outstanding debts (loans, credit cards, etc.)')
                .setRequired(true))
        .addBooleanOption(option =>
            option.setName('own_home')
                .setDescription('Do you own your residence?')
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
            finalRulingCommand.toJSON(),
            appealNoticeCommand.toJSON(),
            certiorariCommand.toJSON(),
            financialDisclosureCommand.toJSON()
        ]);
        console.log('Successfully registered slash commands!');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
    
    setInterval(checkExpiredDeadlines, 60000); // Check every minute
    setInterval(checkExpiredAppealDeadlines, 60000); // Check every minute for appeal deadlines
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;
    
    // Special handling for case party commands - check if user can send messages in channel
    const casePartyCommands = ['appealnotice', 'certiorari', 'financialdisclosure'];
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
    } else {
        // For all other commands, require the allowed role
        if (!interaction.member.roles.cache.has(ALLOWED_ROLE_ID)) {
            await interaction.reply({ 
                content: 'You do not have permission to use this bot.', 
                flags: 64 
            });
            return;
        }
    }
    
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
        const clerk = interaction.options.getUser('clerk');
        const plaintiff = interaction.options.getUser('plaintiff');
        const defendant = interaction.options.getUser('defendant');
        const caseLink = interaction.options.getString('case_link');
        
        try {
            // Create the channel with proper permissions
            const channel = await interaction.guild.channels.create({
                name: caseCode.toLowerCase().replace(/\s+/g, '-'),
                type: ChannelType.GuildText,
                permissionOverwrites: [
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
                    },
                    {
                        id: clerk.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                    },
                    {
                        id: plaintiff.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                    },
                    {
                        id: defendant.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                    }
                ]
            });
            
            // Save case to database
            await createCase(
                interaction.guildId,
                channel.id,
                caseCode,
                judge.id,
                clerk.id,
                plaintiff.id,
                defendant.id,
                caseLink
            );
            
            // Create case information embed
            const caseEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`Case: ${caseCode}`)
                .setDescription('Discord Courtroom has been initialized\n\n⚖️ **NOTICE:** This channel is fully on the record and reflective of the actual court transcript. Please follow chamber rules.')
                .addFields(
                    { name: 'Judge', value: `<@${judge.id}>`, inline: true },
                    { name: 'Clerk', value: `<@${clerk.id}>`, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true },
                    { name: 'Plaintiff', value: `<@${plaintiff.id}>`, inline: true },
                    { name: 'Defendant', value: `<@${defendant.id}>`, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }
                )
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
            
            // Move channel to archive category
            await channel.setParent(ARCHIVE_CATEGORY_ID);
            
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
                    caseInfo.plaintiff_id,
                    caseInfo.defendant_id,
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
            if (userId === caseInfo.plaintiff_id) {
                partyType = 'Plaintiff';
            } else if (userId === caseInfo.defendant_id) {
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
});

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
            const channel = await client.channels.fetch(deadline.channel_id);
            if (channel) {
                // Remove access for plaintiff and defendant
                await channel.permissionOverwrites.delete(deadline.plaintiff_id);
                await channel.permissionOverwrites.delete(deadline.defendant_id);
                
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
                
                // Mark as processed
                await removePartyAccess(deadline.id);
            }
        }
    } catch (error) {
        console.error('Error checking expired appeal deadlines:', error);
    }
}

client.login(process.env.DISCORD_TOKEN);