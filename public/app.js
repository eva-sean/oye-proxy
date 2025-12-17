// API client with Basic Auth
const API = {
    getAuthHeaders() {
        const token = localStorage.getItem('authToken');
        if (!token) {
            window.location.href = 'login.html';
            return {};
        }
        return {
            'Authorization': `Basic ${token}`,
            'Content-Type': 'application/json'
        };
    },

    async get(endpoint) {
        const response = await fetch(endpoint, {
            headers: this.getAuthHeaders()
        });

        if (response.status === 401) {
            // Unauthorized, clear auth and redirect to login
            localStorage.removeItem('authToken');
            localStorage.removeItem('username');
            window.location.href = 'login.html';
            throw new Error('Unauthorized');
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
    },

    async post(endpoint, data) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: this.getAuthHeaders(),
            body: JSON.stringify(data)
        });

        if (response.status === 401) {
            // Unauthorized, clear auth and redirect to login
            localStorage.removeItem('authToken');
            localStorage.removeItem('username');
            window.location.href = 'login.html';
            throw new Error('Unauthorized');
        }

        if (!response.ok) {
            // Try to parse error message from response
            try {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
            } catch (e) {
                // If JSON parsing fails, use status text
                if (e.message && !e.message.startsWith('HTTP')) {
                    throw e; // Re-throw the error we created above
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        }

        return response.json();
    }
};

// State
let currentUser = null;
let selectedCharger = null;
let messageCount = 0;
let displayedLogs = [];
let messageLimit = 100;
let chargerStatusData = {}; // Store parsed status data per charger
let configurationData = {}; // Store configuration data per charger
let proxyConfig = {}; // Store proxy configuration
let lastFilterState = { charger: '', direction: '', messageType: '', dateFrom: '', dateTo: '' }; // Track filter changes
let pollingInterval = null;
let lastLogTimestamp = 0; // Track last log timestamp for incremental updates
let lastStatusUpdateTime = {}; // Track last status update time per charger for auto-refresh

// Initialize the app
function initApp() {
    // Check authentication
    const authToken = localStorage.getItem('authToken');
    const username = localStorage.getItem('username');

    if (!authToken || !username) {
        window.location.href = 'login.html';
        return;
    }

    currentUser = { username };
    console.log('Authenticated as:', username);

    // Show user info
    updateUserInfo(currentUser);

    // Initialize UI
    setupEventListeners();
    startPolling();
}

// Update user info in header
function updateUserInfo(user) {
    const header = document.querySelector('header');
    const userInfoHtml = `
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-left: auto;">
            <div class="user-menu-container">
                <button id="userMenuBtn" class="user-menu-btn">
                    <span>${user.username}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width: 16px; height: 16px;">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                    </svg>
                </button>
                <div id="userDropdown" class="user-dropdown">
                    <button id="changePasswordMenuBtn" class="dropdown-item">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width: 16px; height: 16px;">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
                        </svg>
                        Change Password
                    </button>
                    <button id="logoutMenuBtn" class="dropdown-item">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width: 16px; height: 16px;">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                        </svg>
                        Sign Out
                    </button>
                </div>
            </div>
            <button id="configIconBtn" class="config-icon-btn" title="Proxy Configuration">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
            </button>
        </div>
    `;

    // Insert before header-stats or append
    const headerStats = document.querySelector('.header-stats');
    if (headerStats) {
        headerStats.insertAdjacentHTML('afterend', userInfoHtml);
    } else {
        header.insertAdjacentHTML('beforeend', userInfoHtml);
    }

    // Add config icon handler
    document.getElementById('configIconBtn').addEventListener('click', () => {
        openConfigModal();
    });

    // Add user menu toggle handler
    const userMenuBtn = document.getElementById('userMenuBtn');
    const userDropdown = document.getElementById('userDropdown');

    userMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle('show');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.user-menu-container')) {
            userDropdown.classList.remove('show');
        }
    });

    // Add change password handler
    document.getElementById('changePasswordMenuBtn').addEventListener('click', () => {
        userDropdown.classList.remove('show');
        openPasswordModal();
    });

    // Add logout handler
    document.getElementById('logoutMenuBtn').addEventListener('click', async () => {
        try {
            localStorage.removeItem('authToken');
            localStorage.removeItem('username');
            window.location.href = 'login.html';
        } catch (error) {
            console.error('Logout error:', error);
            alert('Failed to sign out: ' + error.message);
        }
    });
}

// Setup event listeners
function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.dataset.tab;
            switchTab(tabName);
        });
    });

    // Charger list collapse toggle
    const chargerListHeader = document.querySelector('.charger-list h2');
    const chargerList = document.querySelector('.charger-list');
    chargerListHeader.addEventListener('click', () => {
        chargerList.classList.toggle('collapsed');
    });

    // Controls/Filters collapse toggle
    const controlsHeader = document.querySelector('.controls-header');
    const controls = document.querySelector('.controls');
    if (controlsHeader && controls) {
        controlsHeader.addEventListener('click', () => {
            controls.classList.toggle('collapsed');
        });
    }

    // Charger filter
    document.getElementById('chargerFilter').addEventListener('input', (e) => {
        filterChargers(e.target.value);
    });

    // Log filters
    document.getElementById('chargerSelect').addEventListener('change', filterLogs);
    document.getElementById('directionFilter').addEventListener('change', filterLogs);
    document.getElementById('messageTypeFilter').addEventListener('change', filterLogs);
    document.getElementById('messageLimitFilter').addEventListener('change', updateMessageLimit);
    document.getElementById('timeRangeFilter').addEventListener('change', handleTimeRangeChange);
    document.getElementById('dateFrom').addEventListener('change', filterLogs);
    document.getElementById('dateTo').addEventListener('change', filterLogs);

    // Clear filters button
    document.getElementById('clearFilters').addEventListener('click', () => {
        document.getElementById('chargerSelect').value = '';
        document.getElementById('directionFilter').value = '';
        document.getElementById('messageTypeFilter').value = '';
        document.getElementById('timeRangeFilter').value = '';
        document.getElementById('dateFrom').value = '';
        document.getElementById('dateTo').value = '';
        selectedCharger = null;
        document.querySelectorAll('.charger-item').forEach(item => {
            item.classList.remove('selected');
        });
        filterLogs();
    });

    // Inject form
    document.getElementById('injectBtn').addEventListener('click', injectCommand);
    document.getElementById('clearForm').addEventListener('click', clearInjectForm);
    document.getElementById('ocppAction').addEventListener('change', updatePayloadTemplate);

    // Status tab controls
    document.getElementById('statusChargerSelect').addEventListener('change', loadChargerStatus);
    document.getElementById('refreshStatus').addEventListener('click', () => {
        const chargerId = document.getElementById('statusChargerSelect').value;
        if (chargerId) {
            loadChargerStatus();
        }
    });

    // Status page buttons (added dynamically, using event delegation)
    document.addEventListener('click', async (e) => {
        // Configuration refresh button
        if (e.target && e.target.id === 'refreshConfiguration') {
            const chargerId = document.getElementById('statusChargerSelect').value;
            if (chargerId) {
                await refreshConfiguration(chargerId);
            }
        }

        // Edit configuration icon
        if (e.target && (e.target.classList.contains('edit-config-icon') || e.target.closest('.edit-config-icon'))) {
            const btn = e.target.classList.contains('edit-config-icon') ? e.target : e.target.closest('.edit-config-icon');
            const chargerId = btn.dataset.chargerId;
            const configKey = btn.dataset.configKey;
            const configValue = btn.dataset.configValue;
            if (chargerId && configKey) {
                editConfigurationItem(chargerId, configKey, configValue);
            }
        }

        // Refresh connector status button
        if (e.target && e.target.classList.contains('refresh-connector-status')) {
            const chargerId = e.target.dataset.chargerId;
            if (chargerId) {
                await refreshConnectorStatus(chargerId);
            }
        }

        // Start charge button
        if (e.target && e.target.classList.contains('start-charge')) {
            const chargerId = e.target.dataset.chargerId;
            const connectorId = e.target.dataset.connectorId;
            if (chargerId && connectorId) {
                await startCharge(chargerId, connectorId, e.target);
            }
        }

        // Stop charge button
        if (e.target && e.target.classList.contains('stop-charge')) {
            const chargerId = e.target.dataset.chargerId;
            const connectorId = e.target.dataset.connectorId;
            if (chargerId && connectorId) {
                await stopCharge(chargerId, connectorId, e.target);
            }
        }

        // Smart Charging: Apply Max Power
        if (e.target.closest('.apply-smart-charging-max')) {
            const btn = e.target.closest('.apply-smart-charging-max');
            const chargerId = btn.dataset.chargerId;
            const maxPowerInput = document.getElementById('scMaxPower');

            if (maxPowerInput) {
                updateSmartCharging(chargerId, maxPowerInput.value, null, null, btn, 'max');
            }
        }

        // Smart Charging: Apply Session Limit
        if (e.target.closest('.apply-smart-charging-session')) {
            const btn = e.target.closest('.apply-smart-charging-session');
            const chargerId = btn.dataset.chargerId;
            const transactionId = btn.dataset.transactionId;
            const sessionInput = document.getElementById('scSessionLimit');

            if (sessionInput) {
                updateSmartCharging(chargerId, null, sessionInput.value, transactionId, btn, 'session');
            }
        }

        // Smart Charging: Clear
        if (e.target.closest('.clear-smart-charging')) {
            const btn = e.target.closest('.clear-smart-charging');
            const chargerId = btn.dataset.chargerId;
            if (chargerId) {
                if (confirm('Are you sure you want to clear all charging profiles and remove the persistent limit?')) {
                    await updateSmartCharging(chargerId, undefined, undefined, null, btn, 'clear');
                    // Clear inputs
                    const maxP = document.getElementById('scMaxPower');
                    const sessL = document.getElementById('scSessionLimit');
                    if (maxP) maxP.value = '';
                    if (sessL) sessL.value = '';
                }
            }
        }
    });

    // Proxy configuration (in modal)
    document.getElementById('saveConfigBtn').addEventListener('click', saveProxyConfig);
    document.getElementById('reloadConfigBtn').addEventListener('click', loadProxyConfig);

    // Password change modal
    document.getElementById('changePasswordBtn').addEventListener('click', changePassword);
    document.getElementById('closePasswordModal').addEventListener('click', closePasswordModal);

    // Modal controls
    document.getElementById('closeConfigModal').addEventListener('click', closeConfigModal);

    // Close modal when clicking outside
    document.getElementById('configModal').addEventListener('click', (e) => {
        if (e.target.id === 'configModal') {
            closeConfigModal();
        }
    });

    document.getElementById('passwordModal').addEventListener('click', (e) => {
        if (e.target.id === 'passwordModal') {
            closePasswordModal();
        }
    });

    // Close modals on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeConfigModal();
            closePasswordModal();
        }
    });
}

// Update message limit
function updateMessageLimit() {
    const newLimit = parseInt(document.getElementById('messageLimitFilter').value, 10);
    if (newLimit !== messageLimit) {
        messageLimit = newLimit;
        // Clear logs and reset timestamp to fetch fresh data
        displayedLogs = [];
        lastLogTimestamp = 0;
        document.getElementById('logsContainer').innerHTML = '';
        fetchLogs();
    }
}

// Handle time range filter changes
function handleTimeRangeChange() {
    const timeRange = document.getElementById('timeRangeFilter').value;
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');

    if (timeRange === '1h') {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - (60 * 60 * 1000));
        dateFrom.value = formatDateTimeLocal(oneHourAgo);
        dateTo.value = formatDateTimeLocal(now);
    } else if (timeRange === '24h') {
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        dateFrom.value = formatDateTimeLocal(oneDayAgo);
        dateTo.value = formatDateTimeLocal(now);
    }
    // If custom range, don't modify the date inputs

    filterLogs();
}

// Format date for datetime-local input
function formatDateTimeLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Tab switching
function switchTab(tabName) {
    // Update buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `${tabName}-tab`);
    });
}

// Start polling for updates
function startPolling() {
    // Initial fetch
    fetchChargers();
    fetchLogs();
    loadProxyConfig();

    // Poll every 5 seconds
    pollingInterval = setInterval(() => {
        const autorefresh = document.getElementById('autorefresh').checked;
        fetchChargers();
        if (autorefresh) {
            fetchLogs();
        }
    }, 5000);
}

// Fetch chargers from API
async function fetchChargers() {
    try {
        const chargers = await API.get('/api/chargers');
        updateChargersList(chargers);
    } catch (error) {
        console.error('Error fetching chargers:', error);
    }
}

// Fetch logs from API
async function fetchLogs() {
    try {
        // Build query parameters
        const params = new URLSearchParams();
        params.append('limit', messageLimit.toString());

        if (lastLogTimestamp > 0) {
            // Convert back to seconds for the API call
            params.append('since', Math.floor(lastLogTimestamp / 1000).toString());
        }

        const logs = await API.get(`/api/logs?${params}`);

        // Add new logs to displayed logs
        if (Array.isArray(logs)) {
            logs.forEach(log => {
                // Convert timestamp from seconds to milliseconds
                const timestampMs = (log.timestamp || 0) * 1000;

                // Update last timestamp
                if (timestampMs > lastLogTimestamp) {
                    lastLogTimestamp = timestampMs;
                }

                // Check if log already exists
                if (!displayedLogs.some(l => l.id === log.id)) {
                    // Store log with converted timestamp
                    addLogEntry({ ...log, timestamp: timestampMs });
                    messageCount++;
                }
            });

            document.getElementById('messageCount').textContent = messageCount;

            // Render all logs after adding them
            filterLogs();
        }
    } catch (error) {
        console.error('Error fetching logs:', error);
    }
}

// Update chargers list
function updateChargersList(chargers) {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    // Process chargers
    const processedChargers = chargers.map(charger => {
        // Convert last_seen from seconds to milliseconds
        const lastSeenTimestamp = (charger.last_seen || 0) * 1000;
        const apiStatus = charger.status; // 'ONLINE' or 'OFFLINE' from API
        const isStale = lastSeenTimestamp <= oneHourAgo;

        return {
            id: charger.charge_point_id,
            lastSeen: lastSeenTimestamp,
            status: apiStatus,
            isStale: isStale
        };
    });

    // Update online count
    const onlineCount = processedChargers.filter(c => c.status === 'ONLINE').length;
    document.getElementById('onlineCount').textContent = onlineCount;

    // Update chargers list
    const chargersListEl = document.getElementById('chargersList');
    const chargerSelectEl = document.getElementById('chargerSelect');
    const injectChargerEl = document.getElementById('injectCharger');

    // Update select options
    const currentSelectValue = chargerSelectEl.value;
    const currentInjectValue = injectChargerEl.value;
    const statusChargerEl = document.getElementById('statusChargerSelect');
    const currentStatusValue = statusChargerEl.value;

    chargerSelectEl.innerHTML = '<option value="">All Chargers</option>';
    injectChargerEl.innerHTML = '<option value="">Select a charger...</option>';
    statusChargerEl.innerHTML = '<option value="">Select a charger...</option>';

    // Clear and rebuild chargers list
    chargersListEl.innerHTML = '';

    processedChargers.sort((a, b) => a.id.localeCompare(b.id)).forEach(charger => {
        // Add to sidebar
        const item = document.createElement('div');
        // Determine CSS class based on status and staleness
        let statusClass = 'offline'; // default
        if (charger.isStale) {
            statusClass = 'stale';
        } else if (charger.status === 'ONLINE') {
            statusClass = 'online';
        } else if (charger.status === 'OFFLINE') {
            statusClass = 'offline';
        }

        item.className = `charger-item ${statusClass}`;
        if (selectedCharger === charger.id) {
            item.classList.add('selected');
        }
        item.innerHTML = `
            <span class="charger-name">${charger.id}</span>
            <div class="charger-status">${formatTimestamp(charger.lastSeen)}</div>
        `;
        item.addEventListener('click', () => {
            selectCharger(charger.id);
        });
        chargersListEl.appendChild(item);

        // Add to selects
        const option1 = document.createElement('option');
        option1.value = charger.id;
        option1.textContent = charger.id;
        chargerSelectEl.appendChild(option1);

        const option2 = document.createElement('option');
        option2.value = charger.id;
        option2.textContent = charger.id;
        injectChargerEl.appendChild(option2);

        const option3 = document.createElement('option');
        option3.value = charger.id;
        option3.textContent = charger.id;
        statusChargerEl.appendChild(option3);
    });

    // Restore selections
    chargerSelectEl.value = currentSelectValue;
    injectChargerEl.value = currentInjectValue;
    statusChargerEl.value = currentStatusValue;

    filterChargers(document.getElementById('chargerFilter').value);
}

// Select a charger from sidebar
function selectCharger(chargerId) {
    selectedCharger = chargerId;

    // Update UI
    document.querySelectorAll('.charger-item').forEach(item => {
        item.classList.toggle('selected', item.querySelector('.charger-name').textContent === chargerId);
    });

    // Auto-collapse charger list on mobile when a charger is selected
    if (window.innerWidth <= 768) {
        const chargerList = document.querySelector('.charger-list');
        chargerList.classList.add('collapsed');
    }

    // Check which tab is active
    const activeTab = document.querySelector('.tab-button.active').dataset.tab;

    if (activeTab === 'status') {
        // Update status tab and load status
        document.getElementById('statusChargerSelect').value = chargerId;
        loadChargerStatus();
    } else {
        // Update logs filter
        document.getElementById('chargerSelect').value = chargerId;
        filterLogs();
    }
}

// Filter chargers in sidebar
function filterChargers(searchTerm) {
    const term = searchTerm.toLowerCase();
    document.querySelectorAll('.charger-item').forEach(item => {
        const name = item.querySelector('.charger-name').textContent.toLowerCase();
        item.style.display = name.includes(term) ? 'block' : 'none';
    });
}

// Add log entry
function addLogEntry(log) {
    displayedLogs.unshift(log);

    // Keep only configured limit in memory
    if (displayedLogs.length > messageLimit) {
        displayedLogs = displayedLogs.slice(0, messageLimit);
    }

    // Update message types dropdown
    updateMessageTypesDropdown();

    // Update charger status data and check if status screen should refresh
    const shouldRefresh = updateChargerStatusData(log);

    // Auto-refresh status screen if we're viewing this charger and status was updated
    if (shouldRefresh) {
        autoRefreshStatusDisplay(log.charge_point_id);
    }

    // Note: filterLogs() is called in fetchLogs() after all logs are added
}

// Update message types dropdown with available types from current logs
function updateMessageTypesDropdown() {
    const messageTypeFilter = document.getElementById('messageTypeFilter');
    const currentValue = messageTypeFilter.value;

    // Extract all unique message types from displayed logs
    const messageTypes = new Set();

    displayedLogs.forEach(log => {
        try {
            const payload = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
            if (Array.isArray(payload) && payload.length >= 3) {
                const messageType = payload[0];
                if (messageType === 2) {
                    // Call (Request): [2, messageId, action, payload]
                    messageTypes.add(payload[2]);
                } else if (messageType === 3) {
                    // CallResult (Response): [3, messageId, payload]
                    messageTypes.add('CallResult');
                } else if (messageType === 4) {
                    // CallError: [4, messageId, errorCode, errorDescription, errorDetails]
                    messageTypes.add(`CallError: ${payload[2]}`);
                }
            }
        } catch (error) {
            // Ignore parse errors
        }
    });

    // Rebuild dropdown options
    messageTypeFilter.innerHTML = '<option value="">All Message Types</option>';

    Array.from(messageTypes).sort().forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        messageTypeFilter.appendChild(option);
    });

    // Restore previous selection if it still exists
    if (currentValue && Array.from(messageTypes).includes(currentValue)) {
        messageTypeFilter.value = currentValue;
    }
}

// Filter and display logs (client-side filtering for charger/direction/message type/date range)
function filterLogs() {
    const chargerFilter = document.getElementById('chargerSelect').value;
    const directionFilter = document.getElementById('directionFilter').value;
    const messageTypeFilter = document.getElementById('messageTypeFilter').value;
    const dateFromStr = document.getElementById('dateFrom').value;
    const dateToStr = document.getElementById('dateTo').value;
    const container = document.getElementById('logsContainer');
    const autoscroll = document.getElementById('autoscroll').checked;

    // Parse date filters
    const dateFrom = dateFromStr ? new Date(dateFromStr).getTime() : null;
    const dateTo = dateToStr ? new Date(dateToStr).getTime() : null;

    // Check if filters have changed OR if container is empty (first load)
    const filtersChanged =
        container.children.length === 0 ||
        lastFilterState.charger !== chargerFilter ||
        lastFilterState.direction !== directionFilter ||
        lastFilterState.messageType !== messageTypeFilter ||
        lastFilterState.dateFrom !== dateFromStr ||
        lastFilterState.dateTo !== dateToStr;

    // Update filter state
    lastFilterState = {
        charger: chargerFilter,
        direction: directionFilter,
        messageType: messageTypeFilter,
        dateFrom: dateFromStr,
        dateTo: dateToStr
    };

    // Filter logs
    const filtered = displayedLogs.filter(log => {
        if (chargerFilter && log.charge_point_id !== chargerFilter) return false;
        if (directionFilter && log.direction !== directionFilter) return false;

        // Date range filtering
        if (dateFrom && log.timestamp < dateFrom) return false;
        if (dateTo && log.timestamp > dateTo) return false;

        // Message type filtering
        if (messageTypeFilter) {
            try {
                const payload = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
                if (Array.isArray(payload) && payload.length >= 3) {
                    const messageType = payload[0];
                    let logMessageType = '';

                    if (messageType === 2) {
                        logMessageType = payload[2];
                    } else if (messageType === 3) {
                        logMessageType = 'CallResult';
                    } else if (messageType === 4) {
                        logMessageType = `CallError: ${payload[2]}`;
                    }

                    if (logMessageType !== messageTypeFilter) return false;
                } else {
                    return false;
                }
            } catch (error) {
                return false;
            }
        }

        return true;
    });

    // Sort filtered logs by timestamp (newest first) to ensure consistent ordering
    filtered.sort((a, b) => {
        const timeA = a.timestamp || 0;
        const timeB = b.timestamp || 0;
        return timeB - timeA; // Descending order (newest first)
    });

    // If filters changed, rebuild the entire list
    if (filtersChanged) {
        container.innerHTML = '';
        filtered.forEach(log => {
            const entry = createLogElement(log);
            entry.dataset.logId = log.id;
            container.appendChild(entry);
        });
    } else {
        // Incrementally update: only add new logs
        const existingIds = new Set(
            Array.from(container.children).map(el => parseInt(el.dataset.logId))
        );

        // Add only new logs that pass the filter
        filtered.forEach(log => {
            if (!existingIds.has(log.id)) {
                const entry = createLogElement(log);
                entry.dataset.logId = log.id;
                // Insert at the beginning since logs are sorted newest first
                container.insertBefore(entry, container.firstChild);
            }
        });

        // Remove logs that no longer match the filter (shouldn't happen if filters didn't change, but be safe)
        Array.from(container.children).forEach(el => {
            const logId = parseInt(el.dataset.logId);
            const stillMatches = filtered.some(log => log.id === logId);
            if (!stillMatches) {
                el.remove();
            }
        });
    }

    // Auto-scroll to top only for new messages and if autoscroll is enabled
    if (autoscroll && filtered.length > 0) {
        container.scrollTop = 0;
    }
}

// Create log element
function createLogElement(log) {
    const div = document.createElement('div');
    div.className = `log-entry ${log.direction}`;

    const timestamp = formatLogTimestamp(log.timestamp);

    // Parse payload if it's a string
    let payloadObj;
    try {
        payloadObj = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
    } catch (error) {
        payloadObj = log.payload;
    }

    const payload = JSON.stringify(payloadObj, null, 2);

    // Try to extract OCPP action from payload
    let action = 'N/A';
    if (Array.isArray(payloadObj) && payloadObj.length >= 3) {
        const messageType = payloadObj[0];
        if (messageType === 2) {
            // Call (Request): [2, messageId, action, payload]
            action = payloadObj[2];
        } else if (messageType === 3) {
            // CallResult (Response): [3, messageId, payload]
            action = 'CallResult';
        } else if (messageType === 4) {
            // CallError: [4, messageId, errorCode, errorDescription, errorDetails]
            action = `CallError: ${payloadObj[2]}`;
        }
    }

    div.innerHTML = `
        <div class="log-header">
            <span class="log-direction ${log.direction}">${log.direction}</span>
            <div class="log-meta">
                <span class="log-charger">${log.charge_point_id}</span>
                <span>${action}</span>
                <span>${timestamp}</span>
            </div>
        </div>
        <div class="log-payload collapsed">${escapeHtml(payload)}</div>
    `;

    // Add click handler to toggle payload visibility
    const header = div.querySelector('.log-header');
    const payloadEl = div.querySelector('.log-payload');

    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
        payloadEl.classList.toggle('collapsed');
    });

    return div;
}

// Inject command
async function injectCommand() {
    const charger = document.getElementById('injectCharger').value;
    let action = document.getElementById('ocppAction').value;
    const payloadText = document.getElementById('payloadEditor').value;

    // Validate
    if (!charger) {
        showInjectResult('Please select a charge point', false);
        return;
    }

    if (!action) {
        showInjectResult('Please select an OCPP action', false);
        return;
    }

    // Handle custom action
    if (action === '__custom__') {
        const customAction = document.getElementById('customAction').value.trim();
        if (!customAction) {
            showInjectResult('Please enter a custom action name', false);
            return;
        }
        action = customAction;
    }

    // Parse payload
    let payload;
    try {
        payload = payloadText ? JSON.parse(payloadText) : {};
    } catch (error) {
        showInjectResult('Invalid JSON payload: ' + error.message, false);
        return;
    }

    // Send command
    try {
        const result = await API.post(`/api/inject/${charger}`, { action, payload });
        showInjectResult('Command sent successfully! Message ID: ' + result.messageId, true);

        // Switch to logs tab to see the response
        setTimeout(() => {
            switchTab('logs');
            document.getElementById('chargerSelect').value = charger;
            filterLogs();
        }, 1500);

    } catch (error) {
        console.error('Inject error:', error);
        showInjectResult('Failed to inject command: ' + error.message, false);
    }
}

// Show inject result
function showInjectResult(message, success) {
    const resultEl = document.getElementById('injectResult');
    resultEl.textContent = message;
    resultEl.className = 'inject-result ' + (success ? 'success' : 'error');

    // Auto-hide after 5 seconds
    setTimeout(() => {
        resultEl.className = 'inject-result';
    }, 5000);
}

// Clear inject form
function clearInjectForm() {
    document.getElementById('injectCharger').value = '';
    document.getElementById('ocppAction').value = '';
    document.getElementById('payloadEditor').value = '';
    document.getElementById('injectResult').className = 'inject-result';
}

// Update payload template when action changes
function updatePayloadTemplate() {
    const action = document.getElementById('ocppAction').value;
    const payloadEditor = document.getElementById('payloadEditor').value;
    const customActionGroup = document.getElementById('customActionGroup');

    // Show/hide custom action input
    if (action === '__custom__') {
        customActionGroup.style.display = 'block';
        payloadEditor.value = '{}';
    } else {
        customActionGroup.style.display = 'none';
        document.getElementById('customAction').value = '';

        if (action && ocppTemplates[action]) {
            document.getElementById('payloadEditor').value = JSON.stringify(ocppTemplates[action], null, 2);
        } else {
            document.getElementById('payloadEditor').value = '';
        }
    }
}

// Utility functions
function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';

    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    // Less than 1 minute
    if (diff < 60000) {
        return 'Just now';
    }

    // Less than 1 hour
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes}m ago`;
    }

    // Less than 24 hours
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}h ago`;
    }

    // Format as date
    return date.toLocaleString();
}

// Format timestamp for log messages (shows full date/time in browser timezone)
function formatLogTimestamp(timestamp) {
    if (!timestamp) return 'N/A';

    const date = new Date(timestamp);
    return date.toLocaleString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showError(message) {
    const container = document.getElementById('logsContainer');
    container.innerHTML = `<div class="log-entry" style="border-left-color: var(--danger);">
        <div class="log-header">
            <span class="log-direction" style="background: var(--danger);">ERROR</span>
        </div>
        <div class="log-payload">${escapeHtml(message)}</div>
    </div>`;
}

// Update charger status data from log messages
// Returns true if status was updated (for auto-refresh trigger)
function updateChargerStatusData(log) {
    const cpId = log.charge_point_id;
    let statusUpdated = false;

    if (!chargerStatusData[cpId]) {
        chargerStatusData[cpId] = {
            lastSeen: null,
            bootInfo: null,
            connectors: {},
            meterValues: {},
            lastHeartbeat: null,
            transactionIds: {} // Maps connectorId to transactionId
        };
    }

    const data = chargerStatusData[cpId];

    // Get message timestamp
    let messageTimestamp = null;
    if (log.timestamp) {
        messageTimestamp = new Date(log.timestamp);
        // Update last seen time
        if (!data.lastSeen || messageTimestamp > data.lastSeen) {
            data.lastSeen = messageTimestamp;
        }
    }

    // Parse OCPP message
    let payloadObj;
    try {
        payloadObj = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
    } catch (error) {
        return false; // Skip if payload is not valid JSON
    }

    if (Array.isArray(payloadObj) && payloadObj.length >= 3) {
        const messageType = payloadObj[0];

        if (messageType === 2) { // Call (Request)
            const action = payloadObj[2];
            const payload = payloadObj[3];

            // BootNotification
            if (action === 'BootNotification' && payload) {
                data.bootInfo = {
                    chargePointVendor: payload.chargePointVendor,
                    chargePointModel: payload.chargePointModel,
                    chargePointSerialNumber: payload.chargePointSerialNumber,
                    firmwareVersion: payload.firmwareVersion,
                    iccid: payload.iccid,
                    imsi: payload.imsi,
                    meterType: payload.meterType,
                    meterSerialNumber: payload.meterSerialNumber,
                    timestamp: messageTimestamp
                };
                statusUpdated = true;
            }

            // StatusNotification
            if (action === 'StatusNotification' && payload) {
                const connectorId = payload.connectorId || 0;

                // Only update if this is newer data or no existing data
                const existing = data.connectors[connectorId];
                if (!existing || !existing.timestamp || messageTimestamp >= existing.timestamp) {
                    data.connectors[connectorId] = {
                        status: payload.status,
                        errorCode: payload.errorCode,
                        info: payload.info,
                        vendorId: payload.vendorId,
                        vendorErrorCode: payload.vendorErrorCode,
                        timestamp: messageTimestamp
                    };
                    statusUpdated = true;
                }
            }

            // MeterValues
            if (action === 'MeterValues' && payload) {
                const connectorId = payload.connectorId || 0;

                // Extract transaction ID if present
                if (payload.transactionId !== undefined && payload.transactionId !== null) {
                    data.transactionIds[connectorId] = payload.transactionId;
                    statusUpdated = true;
                }

                if (payload.meterValue && Array.isArray(payload.meterValue)) {
                    payload.meterValue.forEach(mv => {
                        if (mv.sampledValue && Array.isArray(mv.sampledValue)) {
                            const mvTimestamp = mv.timestamp ? new Date(mv.timestamp) : messageTimestamp;

                            mv.sampledValue.forEach(sv => {
                                const measurand = sv.measurand || 'Energy.Active.Import.Register';
                                const phase = sv.phase || '';
                                const key = `${connectorId}_${measurand}_${phase}`;

                                // Only update if this is newer data or no existing data
                                const existing = data.meterValues[key];
                                if (!existing || !existing.timestamp || mvTimestamp >= existing.timestamp) {
                                    data.meterValues[key] = {
                                        connectorId: connectorId,
                                        value: sv.value,
                                        unit: sv.unit || 'Wh',
                                        measurand: measurand,
                                        phase: sv.phase,
                                        context: sv.context,
                                        format: sv.format,
                                        location: sv.location,
                                        timestamp: mvTimestamp
                                    };
                                    statusUpdated = true;
                                }
                            });
                        }
                    });
                }
            }

            // Heartbeat
            if (action === 'Heartbeat') {
                // Only update if this is newer data or no existing data
                if (!data.lastHeartbeat || messageTimestamp >= data.lastHeartbeat) {
                    data.lastHeartbeat = messageTimestamp;
                    statusUpdated = true;
                }
            }
        } else if (messageType === 3) { // CallResult (Response)
            const payload = payloadObj[2];

            // Check if this is a GetConfiguration response by looking for configurationKey
            if (payload && payload.configurationKey && Array.isArray(payload.configurationKey)) {
                // Only update if this is newer data or no existing data
                const existing = configurationData[cpId];
                if (!existing || !existing.timestamp || messageTimestamp >= existing.timestamp) {
                    configurationData[cpId] = {
                        configurationKey: payload.configurationKey,
                        unknownKey: payload.unknownKey,
                        timestamp: messageTimestamp
                    };
                    statusUpdated = true;
                }
            }
        }
    }

    return statusUpdated;
}

// Auto-refresh status display if currently viewing this charger
function autoRefreshStatusDisplay(chargerId) {
    // Check if status tab is active
    const activeTab = document.querySelector('.tab-button.active');
    if (!activeTab || activeTab.dataset.tab !== 'status') {
        return; // Not on status tab, skip refresh
    }

    // Check if we're viewing this specific charger
    const statusChargerSelect = document.getElementById('statusChargerSelect');
    if (!statusChargerSelect || statusChargerSelect.value !== chargerId) {
        return; // Not viewing this charger, skip refresh
    }

    // Check if we updated this charger recently (debounce to prevent excessive refreshes)
    const now = Date.now();
    const lastUpdate = lastStatusUpdateTime[chargerId] || 0;
    const timeSinceLastUpdate = now - lastUpdate;

    // Only refresh if it's been more than 1 second since last refresh
    if (timeSinceLastUpdate < 1000) {
        return;
    }

    // Update timestamp and refresh display
    lastStatusUpdateTime[chargerId] = now;
    displayChargerStatus(chargerId);
}

// Load and display charger status
async function loadChargerStatus() {
    const chargerId = document.getElementById('statusChargerSelect').value;
    const displayEl = document.getElementById('statusDisplay');

    if (!chargerId) {
        displayEl.innerHTML = '<p style="color: var(--text-secondary); text-align: center; margin-top: 2rem;">Select a charger to view status information</p>';
        return;
    }

    try {
        // Fetch recent logs for this charger
        const logs = await API.get(`/api/logs?chargePointId=${chargerId}&limit=500`);

        // Reset status data for this charger
        chargerStatusData[chargerId] = {
            lastSeen: null,
            bootInfo: null,
            connectors: {},
            meterValues: {},
            lastHeartbeat: null,
            transactionIds: {}
        };

        // Process all logs (convert timestamps from seconds to milliseconds)
        logs.forEach(log => {
            updateChargerStatusData({ ...log, timestamp: (log.timestamp || 0) * 1000 });
        });

        // Add max_power from updated API response (API was updated to include DB fields in step 208)
        // We need to fetch the charger details again or rely on what fetchChargers() populates?
        // Actually fetchChargers() populates `updateChargersList`.
        // We should probably fetch the single charger info here to get the max_power.
        // Or better, let's just make a quick call to get the specific charger config/info.
        // Since we modified `getChargers` API to include `max_power`, we can fetch the list again or just find it.
        // Optimally, `loadChargerStatus` should trust the data coming from the logs mostly, but for config-like fields (max_power),
        // we need the DB state.

        // Let's fetch the charger details to get max_power
        try {
            const chargers = await API.get('/api/chargers');
            const currentCharger = chargers.find(c => c.charge_point_id === chargerId);
            if (currentCharger) {
                chargerStatusData[chargerId].maxPower = currentCharger.max_power;
            }
        } catch (e) {
            console.error('Failed to fetch charger details for max_power', e);
        }

        // Display the status
        displayChargerStatus(chargerId);

    } catch (error) {
        console.error('Error loading charger status:', error);
        displayEl.innerHTML = `<div class="log-entry" style="border-left-color: var(--danger);">
            <div class="log-header">
                <span class="log-direction" style="background: var(--danger);">ERROR</span>
            </div>
            <div class="log-payload">Failed to load charger status: ${escapeHtml(error.message)}</div>
        </div>`;
    }
}

// Update Smart Charging
async function updateSmartCharging(chargerId, maxPower, sessionLimit, transactionId, btn, type) {
    const originalText = btn.textContent;
    try {
        btn.disabled = true;
        if (type === 'clear') btn.textContent = 'Clearing...';
        else btn.textContent = 'Applying...';

        const payload = {};

        if (type === 'clear') {
            payload.action = 'clear';
        } else if (type === 'max') {
            if (!maxPower) throw new Error('Please enter a Max Power value');
            payload.maxPower = maxPower;
        } else if (type === 'session') {
            if (!sessionLimit) throw new Error('Please enter a Session Limit value');
            payload.sessionLimit = sessionLimit;
            if (transactionId) payload.transactionId = parseInt(transactionId);
        }

        // Only send fields if they have values
        await API.post(`/api/chargers/${chargerId}/smart-charging`, payload);

        // Wait a bit then refresh
        await new Promise(resolve => setTimeout(resolve, 1500));
        await loadChargerStatus();

        // No alert, just finish

    } catch (error) {
        console.error('Error updating smart charging:', error);
        alert('Failed to update: ' + error.message);
    } finally {
        if (btn) {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }
}

// Display charger status
function displayChargerStatus(chargerId) {
    const displayEl = document.getElementById('statusDisplay');
    const data = chargerStatusData[chargerId];

    if (!data) {
        displayEl.innerHTML = '<p style="color: var(--text-secondary); text-align: center; margin-top: 2rem;">No status data available</p>';
        return;
    }

    let html = '<div class="status-sections">';

    // Overview Section
    html += '<div class="status-section">';
    html += '<div style="display: flex; justify-content: space-between; align-items: center;">';
    html += '<h3>Overview</h3>';
    html += `<button class="btn btn-secondary refresh-connector-status" data-charger-id="${chargerId}">Get Connector Status</button>`;
    html += '</div>';
    html += '<div class="status-grid">';
    html += `<div class="status-item"><strong>Charger ID:</strong> ${chargerId}</div>`;
    html += `<div class="status-item"><strong>Last Seen:</strong> ${data.lastSeen ? formatTimestamp(data.lastSeen) : 'N/A'}</div>`;
    html += `<div class="status-item"><strong>Last Heartbeat:</strong> ${data.lastHeartbeat ? formatTimestamp(data.lastHeartbeat) : 'N/A'}</div>`;
    html += '</div>';
    html += '</div>';

    // Boot Information
    if (data.bootInfo) {
        html += '<div class="status-section">';
        html += '<h3>Charger Information</h3>';
        html += '<div class="status-grid">';
        if (data.bootInfo.chargePointVendor) html += `<div class="status-item"><strong>Vendor:</strong> ${data.bootInfo.chargePointVendor}</div>`;
        if (data.bootInfo.chargePointModel) html += `<div class="status-item"><strong>Model:</strong> ${data.bootInfo.chargePointModel}</div>`;
        if (data.bootInfo.chargePointSerialNumber) html += `<div class="status-item"><strong>Serial Number:</strong> ${data.bootInfo.chargePointSerialNumber}</div>`;
        if (data.bootInfo.firmwareVersion) html += `<div class="status-item"><strong>Firmware:</strong> ${data.bootInfo.firmwareVersion}</div>`;
        if (data.bootInfo.iccid) html += `<div class="status-item"><strong>ICCID:</strong> ${data.bootInfo.iccid}</div>`;
        if (data.bootInfo.imsi) html += `<div class="status-item"><strong>IMSI:</strong> ${data.bootInfo.imsi}</div>`;
        if (data.bootInfo.meterType) html += `<div class="status-item"><strong>Meter Type:</strong> ${data.bootInfo.meterType}</div>`;
        if (data.bootInfo.meterSerialNumber) html += `<div class="status-item"><strong>Meter Serial:</strong> ${data.bootInfo.meterSerialNumber}</div>`;
        html += '</div>';
        html += '</div>';
    }

    // Connector Status
    const connectorIds = Object.keys(data.connectors).sort((a, b) => parseInt(a) - parseInt(b));
    if (connectorIds.length > 0) {
        html += '<div class="status-section">';
        html += '<h3>Connector Status</h3>';
        connectorIds.forEach(connectorId => {
            const conn = data.connectors[connectorId];
            const statusClass = conn.status === 'Available' ? 'status-available' :
                conn.status === 'Charging' ? 'status-charging' :
                    conn.status === 'Preparing' ? 'status-preparing' :
                        conn.status === 'Finishing' ? 'status-finishing' :
                            conn.status === 'Faulted' ? 'status-faulted' : 'status-unknown';

            // Determine if charging based on status
            const isCharging = conn.status === 'Charging';

            // Get transaction ID for this connector
            const transactionId = data.transactionIds[connectorId];

            html += `<div class="connector-status ${statusClass}">`;
            html += `<div style="display: flex; justify-content: space-between; align-items: center;">`;
            html += `<h4>Connector ${connectorId}</h4>`;
            html += `<div style="display: flex; gap: 0.5rem;">`;
            html += `<button class="btn btn-primary btn-sm start-charge" data-charger-id="${chargerId}" data-connector-id="${connectorId}" ${isCharging ? 'disabled' : ''}>Start Charge</button>`;
            html += `<button class="btn btn-secondary btn-sm stop-charge" data-charger-id="${chargerId}" data-connector-id="${connectorId}" ${!isCharging ? 'disabled' : ''}>Stop Charge</button>`;
            html += `</div>`;
            html += `</div>`;
            html += '<div class="status-grid">';
            html += `<div class="status-item"><strong>Status:</strong> <span class="status-badge ${statusClass}">${conn.status}</span></div>`;
            html += `<div class="status-item"><strong>Error Code:</strong> ${conn.errorCode || 'NoError'}</div>`;
            if (transactionId !== undefined && transactionId !== null) html += `<div class="status-item"><strong>Transaction ID:</strong> ${transactionId}</div>`;
            if (conn.info) html += `<div class="status-item"><strong>Info:</strong> ${conn.info}</div>`;
            if (conn.vendorId) html += `<div class="status-item"><strong>Vendor ID:</strong> ${conn.vendorId}</div>`;
            if (conn.vendorErrorCode) html += `<div class="status-item"><strong>Vendor Error:</strong> ${conn.vendorErrorCode}</div>`;
            html += `<div class="status-item"><strong>Updated:</strong> ${formatTimestamp(conn.timestamp)}</div>`;
            html += '</div>';
            html += '</div>';
        });
        html += '</div>';
    }

    // Smart Charging Control
    const maxPowerVal = data.maxPower !== undefined && data.maxPower !== null ? data.maxPower : '';

    html += '<div class="status-section">';
    html += '<h3>Smart Charging</h3>';

    // We'll use standard form-group styling but in a grid
    // The .form-group input styles are already defined in css, we just need to use them correctly.
    // However, the inputs in .form-group are styled with `width: 100%`.
    // Let's create a structure similar to the config form.

    html += '<div class="status-grid" style="grid-template-columns: 1fr 1fr; gap: 2rem; align-items: start;">';

    // 1. Persistent Limit Control
    html += '<div class="sc-control-group" style="background: var(--bg-dark); padding: 1rem; border-radius: 0.25rem;">';
    html += '<h4 style="margin-top: 0; margin-bottom: 1rem; font-size: 0.9rem; color: var(--text-secondary);">Persistent Limit</h4>';
    html += '<div class="form-group">';
    html += '<label for="scMaxPower">Max Power (Amps)</label>';
    html += `<input type="number" id="scMaxPower" step="0.1" placeholder="e.g. 16" value="${maxPowerVal}" data-charger-id="${chargerId}" style="width: 100%; padding: 0.75rem; background: var(--bg-medium); border: 1px solid var(--border); border-radius: 0.25rem; color: var(--text-primary);">`;
    html += '<small class="help-text" style="display: block; margin-top: 0.5rem;">Saved to DB and re-applied on reconnection.</small>';
    html += '</div>';
    html += `<button class="btn btn-primary apply-smart-charging-max" data-charger-id="${chargerId}" style="width: 100%;">Apply Max Power</button>`;
    html += '</div>';

    // 2. Session Limit Control
    // Find active transaction on connector 1 (assuming single connector for now or first active one)
    // Ideally we should have a selector if there are multiple connectors, but for now we look for the first active charging session.
    let activeTransactionId = null;
    let activeConnectorId = null;

    // Find connector with Charging status
    Object.keys(data.connectors).forEach(cid => {
        if (data.connectors[cid].status === 'Charging' && data.transactionIds[cid]) {
            activeConnectorId = cid;
            activeTransactionId = data.transactionIds[cid];
        }
    });

    const isCharging = !!activeTransactionId;

    html += '<div class="sc-control-group" style="background: var(--bg-dark); padding: 1rem; border-radius: 0.25rem;">';
    html += '<h4 style="margin-top: 0; margin-bottom: 1rem; font-size: 0.9rem; color: var(--text-secondary);">Session Limit (One-time)</h4>';
    html += '<div class="form-group">';
    html += '<label for="scSessionLimit">Session Limit (Amps)</label>';
    html += `<input type="number" id="scSessionLimit" step="0.1" placeholder="e.g. 10" data-charger-id="${chargerId}" ${!isCharging ? 'disabled' : ''} style="width: 100%; padding: 0.75rem; background: var(--bg-medium); border: 1px solid var(--border); border-radius: 0.25rem; color: var(--text-primary);">`;
    html += '<small class="help-text" style="display: block; margin-top: 0.5rem;">Only available during an active charging session.</small>';
    html += '</div>';
    html += `<button class="btn btn-primary apply-smart-charging-session" data-charger-id="${chargerId}" data-transaction-id="${activeTransactionId || ''}" ${!isCharging ? 'disabled' : ''} style="width: 100%;">Apply Session Limit</button>`;
    html += '</div>';

    html += '</div>'; // grid

    html += '<div style="margin-top: 1rem; text-align: right;">';
    html += `<button class="btn btn-secondary clear-smart-charging" data-charger-id="${chargerId}">Clear All Profiles</button>`;
    html += '</div>';

    html += '</div>';

    // Meter Values
    const meterKeys = Object.keys(data.meterValues).sort();
    if (meterKeys.length > 0) {
        html += '<div class="status-section">';
        html += '<h3>Meter Values</h3>';

        // Group by connector
        const byConnector = {};
        meterKeys.forEach(key => {
            const mv = data.meterValues[key];
            if (!byConnector[mv.connectorId]) {
                byConnector[mv.connectorId] = [];
            }
            byConnector[mv.connectorId].push(mv);
        });

        Object.keys(byConnector).sort((a, b) => parseInt(a) - parseInt(b)).forEach(connectorId => {
            html += `<h4>Connector ${connectorId}</h4>`;
            html += '<div class="meter-grid">';
            byConnector[connectorId].forEach(mv => {
                // Round numeric values to 1 decimal place
                const numValue = parseFloat(mv.value);
                const displayValue = isNaN(numValue) ? mv.value : numValue.toFixed(1);

                html += `<div class="meter-item">`;
                html += `<div class="meter-label">${mv.measurand}${mv.phase ? ' (' + mv.phase + ')' : ''}</div>`;
                html += `<div class="meter-value">${displayValue} ${mv.unit}</div>`;
                if (mv.context) html += `<div class="meter-detail">Context: ${mv.context}</div>`;
                if (mv.location) html += `<div class="meter-detail">Location: ${mv.location}</div>`;
                html += `<div class="meter-detail">${formatTimestamp(mv.timestamp)}</div>`;
                html += `</div>`;
            });
            html += '</div>';
        });
        html += '</div>';
    }

    // OCPP Configuration
    const configData = configurationData[chargerId];
    html += '<div class="status-section">';
    html += '<div style="display: flex; justify-content: space-between; align-items: center;">';
    html += '<h3>OCPP Configuration</h3>';
    html += '<button id="refreshConfiguration" class="btn btn-secondary">Refresh Configuration</button>';
    html += '</div>';

    if (configData && configData.configurationKey && configData.configurationKey.length > 0) {
        html += `<p style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 1rem;">Last updated: ${formatTimestamp(configData.timestamp)}</p>`;
        html += '<div style="overflow-x: auto;">';
        html += '<table class="config-table">';
        html += '<thead><tr><th>Key</th><th>Value</th><th>Readonly</th></tr></thead>';
        html += '<tbody>';

        configData.configurationKey.sort((a, b) => (a.key || '').localeCompare(b.key || '')).forEach(item => {
            const readonly = item.readonly ? 'Yes' : 'No';
            const value = item.value !== undefined && item.value !== null ? escapeHtml(String(item.value)) : '<em style="color: var(--text-secondary);">empty</em>';
            const rawValue = item.value !== undefined && item.value !== null ? String(item.value) : '';

            html += `<tr><td><strong>${escapeHtml(item.key)}</strong></td><td>`;
            html += value;

            // Add edit icon for non-readonly items
            if (!item.readonly) {
                html += ` <button class="edit-config-icon" data-charger-id="${chargerId}" data-config-key="${escapeHtml(item.key)}" data-config-value="${escapeHtml(rawValue)}" title="Edit configuration">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/>
                    </svg>
                </button>`;
            }

            html += `</td><td>${readonly}</td></tr>`;
        });

        html += '</tbody>';
        html += '</table>';
        html += '</div>';

        if (configData.unknownKey && configData.unknownKey.length > 0) {
            html += '<p style="margin-top: 1rem; font-size: 0.875rem; color: var(--warning);"><strong>Unknown keys:</strong> ' + configData.unknownKey.join(', ') + '</p>';
        }
    } else {
        html += '<p style="color: var(--text-secondary); text-align: center; margin: 2rem 0;">No configuration data available. Click "Refresh Configuration" to request it from the charger.</p>';
    }

    html += '</div>';

    // No data message
    if (!data.bootInfo && connectorIds.length === 0 && meterKeys.length === 0) {
        html += '<p style="color: var(--text-secondary); text-align: center; margin-top: 2rem;">No detailed status information available for this charger yet.</p>';
    }

    html += '</div>'; // Close status-sections

    displayEl.innerHTML = html;
}

// Edit configuration item - switch to Inject Command tab with pre-filled values
function editConfigurationItem(chargerId, configKey, configValue) {
    // Switch to inject tab
    switchTab('inject');

    // Set the charger
    document.getElementById('injectCharger').value = chargerId;

    // Set the action to ChangeConfiguration
    document.getElementById('ocppAction').value = 'ChangeConfiguration';

    // Set the payload with the configuration key and current value
    const payload = {
        key: configKey,
        value: configValue
    };

    document.getElementById('payloadEditor').value = JSON.stringify(payload, null, 2);

    // Clear any previous result messages
    document.getElementById('injectResult').className = 'inject-result';

    // Scroll to top of page
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Refresh configuration by injecting GetConfiguration command
async function refreshConfiguration(chargerId) {
    const btn = document.getElementById('refreshConfiguration');
    if (!btn) return;

    try {
        // Disable button and show loading state
        btn.disabled = true;
        btn.textContent = 'Requesting...';

        // Inject GetConfiguration command
        const result = await API.post(`/api/inject/${chargerId}`, {
            action: 'GetConfiguration',
            payload: { key: [] } // Empty array means get all keys
        });

        console.log('GetConfiguration command sent, messageId:', result.messageId);

        // Wait 5 seconds for response
        btn.textContent = 'Waiting for response...';
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Reload status
        btn.textContent = 'Refreshing...';
        await loadChargerStatus();

        btn.textContent = 'Refresh Configuration';
        btn.disabled = false;

    } catch (error) {
        console.error('Error refreshing configuration:', error);
        alert('Failed to refresh configuration: ' + error.message);
        btn.textContent = 'Refresh Configuration';
        btn.disabled = false;
    }
}

// Refresh connector status by injecting TriggerMessage command
async function refreshConnectorStatus(chargerId) {
    const btn = document.querySelector('.refresh-connector-status');
    if (!btn) return;

    const originalText = btn.textContent;

    try {
        btn.disabled = true;
        btn.textContent = 'Requesting...';

        // Inject TriggerMessage command for StatusNotification
        const result = await API.post(`/api/inject/${chargerId}`, {
            action: 'TriggerMessage',
            payload: { requestedMessage: 'StatusNotification' }
        });

        console.log('TriggerMessage command sent, messageId:', result.messageId);

        // Wait 3 seconds for response
        btn.textContent = 'Waiting for response...';
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Reload status
        btn.textContent = 'Refreshing...';
        await loadChargerStatus();

        btn.textContent = originalText;
        btn.disabled = false;

    } catch (error) {
        console.error('Error refreshing connector status:', error);
        alert('Failed to refresh connector status: ' + error.message);
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// Start charge on a connector
async function startCharge(chargerId, connectorId, btn) {
    const originalText = btn.textContent;

    // Get ID tag from proxy config, fallback to ADMIN_TAG
    const idTag = proxyConfig.defaultIdTag || 'ADMIN_TAG';

    try {
        btn.disabled = true;
        btn.textContent = 'Starting...';

        // Inject RemoteStartTransaction command
        const result = await API.post(`/api/inject/${chargerId}`, {
            action: 'RemoteStartTransaction',
            payload: {
                connectorId: parseInt(connectorId),
                idTag: idTag
            }
        });

        console.log('RemoteStartTransaction command sent with idTag:', idTag, 'messageId:', result.messageId);

        // Wait 3 seconds for response
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Reload status
        await loadChargerStatus();

        btn.textContent = originalText;
        btn.disabled = false;

    } catch (error) {
        console.error('Error starting charge:', error);
        alert('Failed to start charge: ' + error.message);
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// Stop charge on a connector
async function stopCharge(chargerId, connectorId, btn) {
    const originalText = btn.textContent;

    try {
        btn.disabled = true;
        btn.textContent = 'Stopping...';

        // Get transaction ID from charger status data
        const data = chargerStatusData[chargerId];
        const transactionId = data && data.transactionIds ? data.transactionIds[connectorId] : null;

        const payload = {};
        if (transactionId !== undefined && transactionId !== null) {
            payload.transactionId = parseInt(transactionId);
            console.log('Using transaction ID:', transactionId);
        } else {
            console.warn('No transaction ID found for connector', connectorId);
        }

        // Inject RemoteStopTransaction command
        const result = await API.post(`/api/inject/${chargerId}`, {
            action: 'RemoteStopTransaction',
            payload: payload
        });

        console.log('RemoteStopTransaction command sent, messageId:', result.messageId);

        // Wait 3 seconds for response
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Reload status
        await loadChargerStatus();

        btn.textContent = originalText;
        btn.disabled = false;

    } catch (error) {
        console.error('Error stopping charge:', error);
        alert('Failed to stop charge: ' + error.message);
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// Load proxy configuration from API
async function loadProxyConfig() {
    const displayEl = document.getElementById('configDisplay');

    try {
        const config = await API.get('/api/config');

        // Store config globally for use in other functions
        proxyConfig = config;

        // Parse csmsForwardingEnabled (handle both boolean and string values)
        const forwardingEnabled = config.csmsForwardingEnabled === true || config.csmsForwardingEnabled === 'true';
        const autoChargeEnabled = config.autoChargeEnabled === true || config.autoChargeEnabled === 'true';

        // Update form fields
        document.getElementById('targetCsmsUrl').value = config.targetCsmsUrl || '';
        document.getElementById('csmsForwardingEnabled').checked = forwardingEnabled;
        document.getElementById('autoChargeEnabled').checked = autoChargeEnabled;
        document.getElementById('defaultIdTag').value = config.defaultIdTag || 'ADMIN_TAG';

        // Display current config
        let html = '<div class="status-grid">';
        html += `<div class="status-item"><strong>Target CSMS URL:</strong> ${escapeHtml(config.targetCsmsUrl || 'Not set')}</div>`;
        html += `<div class="status-item"><strong>CSMS Forwarding:</strong> <span class="status-badge ${forwardingEnabled ? 'status-available' : 'status-faulted'}">${forwardingEnabled ? 'Enabled' : 'Disabled'}</span></div>`;
        html += `<div class="status-item"><strong>Auto Charging:</strong> <span class="status-badge ${autoChargeEnabled ? 'status-available' : 'status-faulted'}">${autoChargeEnabled ? 'Enabled' : 'Disabled'}</span></div>`;
        html += `<div class="status-item"><strong>Default ID Tag:</strong> ${escapeHtml(config.defaultIdTag || 'ADMIN_TAG')}</div>`;
        html += '</div>';

        displayEl.innerHTML = html;
    } catch (error) {
        console.error('Error loading proxy config:', error);
        showConfigResult('Failed to load configuration: ' + error.message, false);
    }
}

// Save proxy configuration to API
async function saveProxyConfig() {
    const targetCsmsUrl = document.getElementById('targetCsmsUrl').value.trim();
    const csmsForwardingEnabled = document.getElementById('csmsForwardingEnabled').checked;
    const autoChargeEnabled = document.getElementById('autoChargeEnabled').checked;
    const defaultIdTag = document.getElementById('defaultIdTag').value.trim();

    // Validate URL
    if (!targetCsmsUrl) {
        showConfigResult('Please enter a target CSMS URL', false);
        return;
    }

    if (!targetCsmsUrl.startsWith('ws://') && !targetCsmsUrl.startsWith('wss://')) {
        showConfigResult('URL must start with ws:// or wss://', false);
        return;
    }

    // Validate default ID tag
    if (!defaultIdTag) {
        showConfigResult('Please enter a default ID tag', false);
        return;
    }

    try {
        await API.post('/api/config', {
            targetCsmsUrl: targetCsmsUrl,
            csmsForwardingEnabled: csmsForwardingEnabled,
            autoChargeEnabled: autoChargeEnabled,
            defaultIdTag: defaultIdTag
        });

        showConfigResult('Configuration saved successfully!', true);

        // Reload config display
        setTimeout(() => loadProxyConfig(), 1000);

    } catch (error) {
        console.error('Error saving proxy config:', error);
        showConfigResult('Failed to save configuration: ' + error.message, false);
    }
}

// Show config result message
function showConfigResult(message, success) {
    const resultEl = document.getElementById('configResult');
    resultEl.textContent = message;
    resultEl.className = 'config-result ' + (success ? 'success' : 'error');

    // Auto-hide after 5 seconds
    setTimeout(() => {
        resultEl.className = 'config-result';
    }, 5000);
}

// Open config modal
function openConfigModal() {
    const modal = document.getElementById('configModal');
    modal.classList.add('show');
    // Load current config when opening
    loadProxyConfig();
}

// Close config modal
function closeConfigModal() {
    const modal = document.getElementById('configModal');
    modal.classList.remove('show');
    // Clear any result messages
    const resultEl = document.getElementById('configResult');
    resultEl.className = 'config-result';
}

// Open password modal
function openPasswordModal() {
    const modal = document.getElementById('passwordModal');
    modal.classList.add('show');
}

// Close password modal
function closePasswordModal() {
    const modal = document.getElementById('passwordModal');
    modal.classList.remove('show');
    // Clear any result messages
    const passwordResultEl = document.getElementById('passwordResult');
    passwordResultEl.className = 'password-result';
    // Clear password fields
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
}

// Change password
async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
        showPasswordResult('Please fill in all password fields', false);
        return;
    }

    if (newPassword.length < 8) {
        showPasswordResult('New password must be at least 8 characters long', false);
        return;
    }

    if (newPassword !== confirmPassword) {
        showPasswordResult('New passwords do not match', false);
        return;
    }

    try {
        await API.post('/api/change-password', {
            currentPassword: currentPassword,
            newPassword: newPassword
        });

        showPasswordResult('Password changed successfully!', true);

        // Clear password fields
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';

    } catch (error) {
        console.error('Error changing password:', error);
        showPasswordResult(error.message, false);
    }
}

// Show password result message
function showPasswordResult(message, success) {
    const resultEl = document.getElementById('passwordResult');
    resultEl.textContent = message;
    resultEl.className = 'password-result ' + (success ? 'success' : 'error');

    // Auto-hide after 5 seconds
    setTimeout(() => {
        resultEl.className = 'password-result';
    }, 5000);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
