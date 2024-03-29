// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
const ByteArray = imports.byteArray;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const NetworkManager = imports.gi.NetworkManager;
const NMClient = imports.gi.NMClient;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ModemManager = imports.misc.modemManager;
const Util = imports.misc.util;

const NMConnectionCategory = {
    INVALID: 'invalid',
    WIRED: 'wired',
    WIRELESS: 'wireless',
    WWAN: 'wwan',
    VPN: 'vpn'
};

const NMAccessPointSecurity = {
    UNKNOWN: 0,
    NONE: 1,
    WEP: 2,
    WPA_PSK: 3,
    WPA2_PSK: 4,
    WPA_ENT: 5,
    WPA2_ENT: 6
};

// small optimization, to avoid using [] all the time
const NM80211Mode = NetworkManager['80211Mode'];
const NM80211ApFlags = NetworkManager['80211ApFlags'];
const NM80211ApSecurityFlags = NetworkManager['80211ApSecurityFlags'];

// number of wireless networks that should be visible
// (the remaining are placed into More...)
const NUM_VISIBLE_NETWORKS = 5;

function macToArray(string) {
    return string.split(':').map(function(el) {
        return parseInt(el, 16);
    });
}

function macCompare(one, two) {
    for (let i = 0; i < 6; i++) {
        if (one[i] != two[i])
            return false;
    }
    return true;
}

function ssidCompare(one, two) {
    if (!one || !two)
        return false;
    if (one.length != two.length)
        return false;
    for (let i = 0; i < one.length; i++) {
        if (one[i] != two[i])
            return false;
    }
    return true;
}

// shared between NMNetworkMenuItem and NMDeviceWWAN
function signalToIcon(value) {
    if (value > 80)
        return 'excellent';
    if (value > 55)
        return 'good';
    if (value > 30)
        return 'ok';
    if (value > 5)
        return 'weak';
    return 'none';
}

// shared between NMNetworkMenuItem and NMDeviceWireless
function sortAccessPoints(accessPoints) {
    return accessPoints.sort(function (one, two) {
        return two.strength - one.strength;
    });
}

function ssidToLabel(ssid) {
    let label = NetworkManager.utils_ssid_to_utf8(ssid);
    if (!label)
        label = _("<unknown>");
    return label;
}

const NMNetworkMenuItem = new Lang.Class({
    Name: 'NMNetworkMenuItem',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function(bestAP, title, params) {
        this.parent(params);

        this.bestAP = bestAP;

        if (!title) {
            let ssid = this.bestAP.get_ssid();
            title = ssidToLabel(ssid);
        }

        this._label = new St.Label({ text: title });
        this.actor.label_actor = this._label;
        this.addActor(this._label);
        this._icons = new St.BoxLayout({ style_class: 'nm-menu-item-icons' });
        this.addActor(this._icons, { align: St.Align.END });

        this._signalIcon = new St.Icon({ icon_name: this._getIcon(),
                                         style_class: 'popup-menu-icon' });
        this._icons.add_actor(this._signalIcon);

        this._secureIcon = new St.Icon({ style_class: 'popup-menu-icon' });
        if (this.bestAP._secType != NMAccessPointSecurity.UNKNOWN &&
            this.bestAP._secType != NMAccessPointSecurity.NONE)
            this._secureIcon.icon_name = 'network-wireless-encrypted';
        this._icons.add_actor(this._secureIcon);
    },

    updateBestAP: function(ap) {
        this.bestAP = ap;
        this._signalIcon.icon_name = this._getIcon();
    },

    _getIcon: function() {
        if (this.bestAP.mode == NM80211Mode.ADHOC)
            return 'network-workgroup';
        else
            return 'network-wireless-signal-' + signalToIcon(this.bestAP.strength);
    }
});

const NMWiredSectionTitleMenuItem = new Lang.Class({
    Name: 'NMWiredSectionTitleMenuItem',
    Extends: PopupMenu.PopupSwitchMenuItem,

    _init: function(label, params) {
        params = params || { };
        params.style_class = 'popup-subtitle-menu-item';
        this.parent(label, false, params);
    },

    updateForDevice: function(device) {
        if (device) {
            this._device = device;
            this.setStatus(device.getStatusLabel());
            this.setToggleState(device.connected);
        } else
            this.setStatus('');
    },

    activate: function(event) {
        this.parent(event);

        if (!this._device) {
            log('Section title activated when there is more than one device, should be non reactive');
            return;
        }

        let newState = this._switch.state;

        // Immediately reset the switch to false, it will be updated appropriately
        // by state-changed signals in devices (but fixes the VPN not being in sync
        // if the ActiveConnection object is never seen by libnm-glib)
        this._switch.setToggleState(false);

        if (newState)
            this._device.activate();
        else
            this._device.deactivate();
    }
});

const NMWirelessSectionTitleMenuItem = new Lang.Class({
    Name: 'NMWirelessSectionTitleMenuItem',
    Extends: PopupMenu.PopupSwitchMenuItem,

    _init: function(client, property, title, params) {
        params = params || { };
        params.style_class = 'popup-subtitle-menu-item';
        this.parent(title, false, params);

        this._client = client;
        this._property = property + '_enabled';
        this._propertyHardware = property + '_hardware_enabled';
        this._setEnabledFunc = property + '_set_enabled';

        this._client.connect('notify::' + property + '-enabled', Lang.bind(this, this._propertyChanged));
        this._client.connect('notify::' + property + '-hardware-enabled', Lang.bind(this, this._propertyChanged));

        this._propertyChanged();
    },

    updateForDevice: function(device) {
        // we show the switch
        // - if there not just one device
        // - if the switch is off (but it can be turned on)
        // - if the device is activated or disconnected
        if (!this._hardwareEnabled) {
            this.setStatus(_("hardware disabled"));
        } else if (device && this._softwareEnabled) {
            let text = device.getStatusLabel();
            this.setStatus(text);
        } else
            this.setStatus(null);
    },

    activate: function(event) {
        this.parent(event);

        this._client[this._setEnabledFunc](this._switch.state);
    },

    _propertyChanged: function() {
        this._softwareEnabled = this._client[this._property];
        this._hardwareEnabled = this._client[this._propertyHardware];

        let enabled = this._softwareEnabled && this._hardwareEnabled;
        this.setToggleState(enabled);
        if (!this._hardwareEnabled)
            /* Translators: this indicates that wireless or wwan is disabled by hardware killswitch */
            this.setStatus(_("disabled"));

        this.emit('enabled-changed', enabled);
    }
});

const NMDevice = new Lang.Class({
    Name: 'NMDevice',
    Abstract: true,

    _init: function(client, device, connections) {
        this.device = device;
        if (device) {
            this.device._delegate = this;
            this._stateChangedId = this.device.connect('state-changed', Lang.bind(this, this._deviceStateChanged));
        } else
            this._stateChangedId = 0;

        // protected
        this._client = client;
        this._connections = [ ];
        for (let i = 0; i < connections.length; i++) {
            if (!connections[i].get_uuid())
                continue;
            if (!this.connectionValid(connections[i]))
                continue;
            // record the connection
            let obj = {
                connection: connections[i],
                name: connections[i].get_id(),
                uuid: connections[i].get_uuid(),
                timestamp: connections[i]._timestamp,
                item: null,
            };
            this._connections.push(obj);
        }
        this._connections.sort(this._connectionSortFunction);
        this._activeConnection = null;
        this._activeConnectionItem = null;
        this._autoConnectionItem = null;
        this._overflowItem = null;

        if (this.device) {
            this.statusItem = new PopupMenu.PopupSwitchMenuItem(this._getDescription(), this.connected, { style_class: 'popup-subtitle-menu-item' });
            this._statusChanged = this.statusItem.connect('toggled', Lang.bind(this, function(item, state) {
                if (state)
                    this.activate();
                else
                    this.deactivate();
                this.emit('enabled-changed');
            }));

            this._updateStatusItem();
        }
        this.section = new PopupMenu.PopupMenuSection();

        this._deferredWorkId = Main.initializeDeferredWork(this.section.actor, Lang.bind(this, this._createSection));
    },

    destroy: function() {
        if (this.device)
            this.device._delegate = null;

        if (this._stateChangedId) {
            // Need to go through GObject.Object.prototype because
            // nm_device_disconnect conflicts with g_signal_disconnect
            GObject.Object.prototype.disconnect.call(this.device, this._stateChangedId);
            this._stateChangedId = 0;
        }
        if (this._carrierChangedId) {
            // see above for why this is needed
            GObject.Object.prototype.disconnect.call(this.device, this._carrierChangedId);
            this._carrierChangedId = 0;
        }
        if (this._firmwareChangedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._firmwareChangedId);
            this._firmwareChangedId = 0;
        }

        this._clearSection();
        if (this.statusItem)
            this.statusItem.destroy();
        this.section.destroy();
    },

    deactivate: function() {
        this.device.disconnect(null);
    },

    activate: function() {
        if (this._activeConnection)
            // nothing to do
            return;

        // pick the most recently used connection and connect to that
        // or if no connections ever set, create an automatic one
        if (this._connections.length > 0) {
            this._client.activate_connection(this._connections[0].connection, this.device, null, null);
        } else if (this._autoConnectionName) {
            let connection = this._createAutomaticConnection();
            if (connection)
                this._client.add_and_activate_connection(connection, this.device, null, null);
        }
    },

    get connected() {
        return this.device.state == NetworkManager.DeviceState.ACTIVATED;
    },

    setActiveConnection: function(activeConnection) {
        if (activeConnection == this._activeConnection)
            // nothing to do
            return;

        // remove any UI
        if (this._activeConnectionItem) {
            this._activeConnectionItem.destroy();
            this._activeConnectionItem = null;
        }

        this._activeConnection = activeConnection;

        this._clearSection();
        this._queueCreateSection();
    },

    checkConnection: function(connection) {
        let pos = this._findConnection(connection.get_uuid());
        let exists = pos != -1;
        let valid = this.connectionValid(connection);
        let similar = false;
        if (exists) {
            let existing = this._connections[pos];

            // Check if connection changed name or id
            similar = existing.name == connection.get_id() &&
                existing.timestamp == connection._timestamp;
        }

        if (exists && valid && similar) {
            // Nothing to do
            return;
        }

        if (exists)
            this.removeConnection(connection);
        if (valid)
            this.addConnection(connection);
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection.get_id(),
            uuid: connection.get_uuid(),
            timestamp: connection._timestamp,
            item: null,
        };
        Util.insertSorted(this._connections, obj, this._connectionSortFunction);

        this._clearSection();
        this._queueCreateSection();
    },

    removeConnection: function(connection) {
        let pos = this._findConnection(connection.get_uuid());
        if (pos == -1) {
            // this connection was never added, nothing to do here
            return;
        }

        let obj = this._connections[pos];
        if (obj.item)
            obj.item.destroy();
        this._connections.splice(pos, 1);

        if (this._connections.length <= 1) {
            // We need to show the automatic connection again
            // (or in the case of NMDeviceWired, we want to hide
            // the only explicit connection)
            this._clearSection();
            this._queueCreateSection();
        }
    },

    connectionValid: function(connection) {
        return this.device.connection_valid(connection);
    },

    _connectionSortFunction: function(one, two) {
        if (one.timestamp == two.timestamp)
            return GLib.utf8_collate(one.name, two.name);

        return two.timestamp - one.timestamp;
    },

    setEnabled: function(enabled) {
        // do nothing by default, we want to keep the conneciton list visible
        // in the majority of cases (wired, wwan, vpn)
    },

    getStatusLabel: function() {
        switch(this.device.state) {
        case NetworkManager.DeviceState.DISCONNECTED:
        case NetworkManager.DeviceState.ACTIVATED:
            return null;
        case NetworkManager.DeviceState.UNMANAGED:
            /* Translators: this is for network devices that are physically present but are not
               under NetworkManager's control (and thus cannot be used in the menu) */
            return _("unmanaged");
        case NetworkManager.DeviceState.DEACTIVATING:
            return _("disconnecting...");
        case NetworkManager.DeviceState.PREPARE:
        case NetworkManager.DeviceState.CONFIG:
        case NetworkManager.DeviceState.IP_CONFIG:
        case NetworkManager.DeviceState.IP_CHECK:
        case NetworkManager.DeviceState.SECONDARIES:
            return _("connecting...");
        case NetworkManager.DeviceState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NetworkManager.DeviceState.UNAVAILABLE:
            // This state is actually a compound of various states (generically unavailable,
            // firmware missing, carrier not available), that are exposed by different properties
            // (whose state may or may not updated when we receive state-changed).
            if (!this._firmwareMissingId)
                this._firmwareMissingId = this.device.connect('notify::firmware-missing', Lang.bind(this, this._substateChanged));
            if (this.device.firmware_missing) {
                /* Translators: this is for devices that require some kind of firmware or kernel
                   module, which is missing */
                return _("firmware missing");
            }
            if (this.device.capabilities & NetworkManager.DeviceCapabilities.CARRIER_DETECT) {
                if (!this._carrierChangedId)
                    this._carrierChangedId = this.device.connect('notify::carrier', Lang.bind(this, this._substateChanged));
                if (!this.carrier) {
                    /* Translators: this is for wired network devices that are physically disconnected */
                    return _("cable unplugged");
                }
            }
            /* Translators: this is for a network device that cannot be activated (for example it
               is disabled by rfkill, or it has no coverage */
            return _("unavailable");
        case NetworkManager.DeviceState.FAILED:
            return _("connection failed");
        default:
            log('Device state invalid, is %d'.format(this.device.state));
            return 'invalid';
        }
    },

    // protected
    _createAutomaticConnection: function() {
        throw new TypeError('Invoking pure virtual function NMDevice.createAutomaticConnection');
    },

    _findConnection: function(uuid) {
        for (let i = 0; i < this._connections.length; i++) {
            let obj = this._connections[i];
            if (obj.uuid == uuid)
                return i;
        }
        return -1;
    },

    _queueCreateSection: function() {
        this._clearSection();
        Main.queueDeferredWork(this._deferredWorkId);
    },

    _clearSection: function() {
        // Clear everything
        this.section.removeAll();
        this._autoConnectionItem = null;
        this._activeConnectionItem = null;
        this._overflowItem = null;
        for (let i = 0; i < this._connections.length; i++) {
            this._connections[i].item = null;
        }
    },

    _shouldShowConnectionList: function() {
        return (this.device.state >= NetworkManager.DeviceState.DISCONNECTED);
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this._activeConnection) {
            this._createActiveConnectionItem();
            this.section.addMenuItem(this._activeConnectionItem);
        }
        if (this._connections.length > 0) {
            let activeOffset = this._activeConnectionItem ? 1 : 0;

            for(let j = 0; j < this._connections.length; ++j) {
                let obj = this._connections[j];
                if (this._activeConnection &&
                    obj.connection == this._activeConnection._connection)
                    continue;
                obj.item = this._createConnectionItem(obj);

                if (j + activeOffset >= NUM_VISIBLE_NETWORKS) {
                    if (!this._overflowItem) {
                        this._overflowItem = new PopupMenu.PopupSubMenuMenuItem(_("More..."));
                        this.section.addMenuItem(this._overflowItem);
                    }
                    this._overflowItem.menu.addMenuItem(obj.item);
                } else
                    this.section.addMenuItem(obj.item);
            }
        } else if (this._autoConnectionName) {
            this._autoConnectionItem = new PopupMenu.PopupMenuItem(this._autoConnectionName);
            this._autoConnectionItem.connect('activate', Lang.bind(this, function() {
                let connection = this._createAutomaticConnection();
                if (connection)
                    this._client.add_and_activate_connection(connection, this.device, null, null);
            }));
            this.section.addMenuItem(this._autoConnectionItem);
        }
    },

    _createConnectionItem: function(obj) {
        let connection = obj.connection;
        let item = new PopupMenu.PopupMenuItem(obj.name);

        item.connect('activate', Lang.bind(this, function() {
            this._client.activate_connection(connection, this.device, null, null);
        }));
        return item;
    },

    _createActiveConnectionItem: function() {
        let title;
        let active = this._activeConnection._connection;
        if (active) {
            title = active.get_id();
        } else {
            /* TRANSLATORS: this is the indication that a connection for another logged in user is active,
               and we cannot access its settings (including the name) */
            title = _("Connected (private)");
        }
        this._activeConnectionItem = new PopupMenu.PopupMenuItem(title, { reactive: false });
        this._activeConnectionItem.setShowDot(true);
    },

    _deviceStateChanged: function(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        if (oldstate == NetworkManager.DeviceState.ACTIVATED) {
            this.emit('network-lost');
        }

        if (newstate == NetworkManager.DeviceState.FAILED) {
            this.emit('activation-failed', reason);
        }

        this._updateStatusItem();

        this._clearSection();
        this._queueCreateSection();
        this.emit('state-changed');
    },

    _updateStatusItem: function() {
        if (this._carrierChangedId) {
            // see above for why this is needed
            GObject.Object.prototype.disconnect.call(this.device, this._carrierChangedId);
            this._carrierChangedId = 0;
        }
        if (this._firmwareChangedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._firmwareChangedId);
            this._firmwareChangedId = 0;
        }

        this.statusItem.setStatus(this.getStatusLabel());
        this.statusItem.setToggleState(this.connected);
    },

    _substateChanged: function() {
        this.statusItem.setStatus(this.getStatusLabel());

        this.emit('state-changed');
    },

    _getDescription: function() {
        let dev_product = this.device.get_product();
        let dev_vendor = this.device.get_vendor();
        if (!dev_product || !dev_vendor)
	    return '';

        let product = Util.fixupPCIDescription(dev_product);
        let vendor = Util.fixupPCIDescription(dev_vendor);
        let out = '';

        // Another quick hack; if all of the fixed up vendor string
        // is found in product, ignore the vendor.
        if (product.indexOf(vendor) == -1)
            out += vendor + ' ';
        out += product;

        return out;
    }
});
Signals.addSignalMethods(NMDevice.prototype);


const NMDeviceWired = new Lang.Class({
    Name: 'NMDeviceWired',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        this._autoConnectionName = _("Auto Ethernet");
        this.category = NMConnectionCategory.WIRED;

        this.parent(client, device, connections);
    },

    _createSection: function() {
        this.parent();

        // if we have only one connection (normal or automatic)
        // we hide the connection list, and use the switch to control
        // the device
        // we can do it here because addConnection and removeConnection
        // both call _createSection at some point
        this.section.actor.visible = this._connections.length > 1;
    },

    _createAutomaticConnection: function() {
        let connection = new NetworkManager.Connection();
        let uuid = NetworkManager.utils_uuid_generate();
        connection.add_setting(new NetworkManager.SettingWired());
        connection.add_setting(new NetworkManager.SettingConnection({
            uuid: uuid,
            id: this._autoConnectionName,
            type: NetworkManager.SETTING_WIRED_SETTING_NAME,
            autoconnect: true
        }));
        return connection;
    }
});

const NMDeviceModem = new Lang.Class({
    Name: 'NMDeviceModem',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        let is_wwan = false;

        this._enabled = true;
        this.mobileDevice = null;
        this._connectionType = 'ppp';

        this._capabilities = device.current_capabilities;
        if (this._capabilities & NetworkManager.DeviceModemCapabilities.GSM_UMTS) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemGsm(device.udi);
            this._connectionType = NetworkManager.SETTING_GSM_SETTING_NAME;
        } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.CDMA_EVDO) {
            is_wwan = true;
            this.mobileDevice = new ModemManager.ModemCdma(device.udi);
            this._connectionType = NetworkManager.SETTING_CDMA_SETTING_NAME;
        } else if (this._capabilities & NetworkManager.DeviceModemCapabilities.LTE) {
            is_wwan = true;
            // FIXME: support signal quality
        }

        if (is_wwan) {
            this.category = NMConnectionCategory.WWAN;
            this._autoConnectionName = _("Auto broadband");
        } else {
            this.category = NMConnectionCategory.WIRED;
            this._autoConnectionName = _("Auto dial-up");
        }

        if (this.mobileDevice) {
            this._operatorNameId = this.mobileDevice.connect('notify::operator-name', Lang.bind(this, function() {
                if (this._operatorItem) {
                    let name = this.mobileDevice.operator_name;
                    if (name) {
                        this._operatorItem.label.text = name;
                        this._operatorItem.actor.show();
                    } else
                        this._operatorItem.actor.hide();
                }
            }));
            this._signalQualityId = this.mobileDevice.connect('notify::signal-quality', Lang.bind(this, function() {
                if (this._operatorItem) {
                    this._operatorItem.setIcon(this._getSignalIcon());
                }
            }));
        }

        this.parent(client, device, connections);
    },

    setEnabled: function(enabled) {
        this._enabled = enabled;
        if (this.category == NMConnectionCategory.WWAN) {
            if (enabled) {
                // prevent "network unavailable" statuses
                this.statusItem.setStatus(null);
            } else
                this.statusItem.setStatus(this.getStatusLabel());
        }

        this.parent(enabled);
    },

    get connected() {
        return this._enabled && this.device.state == NetworkManager.DeviceState.ACTIVATED;
    },

    destroy: function() {
        if (this._operatorNameId) {
            this.mobileDevice.disconnect(this._operatorNameId);
            this._operatorNameId = 0;
        }
        if (this._signalQualityId) {
            this.mobileDevice.disconnect(this._signalQualityId);
            this._signalQualityId = 0;
        }

        this.parent();
    },

    _getSignalIcon: function() {
        return 'network-cellular-signal-' + signalToIcon(this.mobileDevice.signal_quality);
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this.mobileDevice) {
            // If operator_name is null, just pass the empty string, as the item is hidden anyway
            this._operatorItem = new PopupMenu.PopupImageMenuItem(this.mobileDevice.operator_name || '',
                                                                  this._getSignalIcon(),
                                                                  { reactive: false });
            if (!this.mobileDevice.operator_name)
                this._operatorItem.actor.hide();
            this.section.addMenuItem(this._operatorItem);
        }

        this.parent();
    },

    _clearSection: function() {
        this._operatorItem = null;

        this.parent();
    },

    _createAutomaticConnection: function() {
        // Mobile wizard is too complex for the shell UI and
        // is handled by the network panel
        Util.spawn(['gnome-control-center', 'network',
                    'connect-3g', this.device.get_path()]);
        return null;
    }
});

const NMDeviceBluetooth = new Lang.Class({
    Name: 'NMDeviceBluetooth',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        this._autoConnectionName = this._makeConnectionName(device);
        device.connect('notify::name', Lang.bind(this, this._updateAutoConnectionName));

        this.category = NMConnectionCategory.WWAN;

        this.parent(client, device, connections);
    },

    _createAutomaticConnection: function() {
        let connection = new NetworkManager.Connection;
        let uuid = NetworkManager.utils_uuid_generate();
        connection.add_setting(new NetworkManager.SettingBluetooth);
        connection.add_setting(new NetworkManager.SettingConnection({
            uuid: uuid,
            id: this._autoConnectionName,
            type: NetworkManager.SETTING_BLUETOOTH_SETTING_NAME,
            autoconnect: false
        }));
        return connection;
    },

    _makeConnectionName: function(device) {
        let name = device.name;
        if (name)
            return _("Auto %s").format(name);
        else
            return _("Auto bluetooth");
    },

    _updateAutoConnectionName: function() {
        this._autoConnectionName = this._makeConnectionName(this.device);

        this._clearSection();
        this._queueCreateSection();
        this._updateStatusItem();
    },

    _getDescription: function() {
        return this.device.name || _("Bluetooth");
    }
});


// Not a real device, but I save a lot code this way
const NMDeviceVPN = new Lang.Class({
    Name: 'NMDeviceVPN',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        // Disable autoconnections
        this._autoConnectionName = null;
        this.category = NMConnectionCategory.VPN;

        this.parent(client, null, connections);
    },

    connectionValid: function(connection) {
        return connection._type == NetworkManager.SETTING_VPN_SETTING_NAME;
    },

    get empty() {
        return this._connections.length == 0;
    },

    get connected() {
        if (!this._activeConnection)
            return false;

        return this._activeConnection.vpn_state == NetworkManager.VPNConnectionState.ACTIVATED;
    },

    setActiveConnection: function(activeConnection) {
        if (this._stateChangeId)
            this._activeConnection.disconnect(this._stateChangeId);
        this._stateChangeId = 0;

        this.parent(activeConnection);

        if (this._activeConnection)
            this._stateChangeId = this._activeConnection.connect('vpn-state-changed',
                                                                 Lang.bind(this, this._connectionStateChanged));

        this.emit('state-changed');
    },

    _shouldShowConnectionList: function() {
        return true;
    },

    deactivate: function() {
        if (this._activeConnection)
            this._client.deactivate_connection(this._activeConnection);
    },

    getStatusLabel: function() {
        if (!this._activeConnection) // Same as DISCONNECTED
            return null;

        switch(this._activeConnection.vpn_state) {
        case NetworkManager.VPNConnectionState.DISCONNECTED:
        case NetworkManager.VPNConnectionState.ACTIVATED:
            return null;
        case NetworkManager.VPNConnectionState.PREPARE:
        case NetworkManager.VPNConnectionState.CONNECT:
        case NetworkManager.VPNConnectionState.IP_CONFIG_GET:
            return _("connecting...");
        case NetworkManager.VPNConnectionState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NetworkManager.VPNConnectionState.FAILED:
            return _("connection failed");
        default:
            log('VPN connection state invalid, is %d'.format(this.device.state));
            return 'invalid';
        }
    },

    _connectionStateChanged: function(connection, newstate, reason) {
        if (newstate == NetworkManager.VPNConnectionState.FAILED) {
            // FIXME: if we ever want to show something based on reason,
            // we need to convert from NetworkManager.VPNConnectionStateReason
            // to NetworkManager.DeviceStateReason
            this.emit('activation-failed', reason);
        }

        // Differently from real NMDevices, there is no need to queue
        // an update of the menu section, contents wouldn't change anyway
        this.emit('state-changed');
    }
});

const NMDeviceWireless = new Lang.Class({
    Name: 'NMDeviceWireless',
    Extends: NMDevice,

    _init: function(client, device, connections) {
        this.category = NMConnectionCategory.WIRELESS;

        this._overflowItem = null;
        this._networks = [ ];

        // breaking the layers with this, but cannot call
        // this.connectionValid until I have a device
        this.device = device;

        let validConnections = connections.filter(Lang.bind(this, function(connection) {
            return this.connectionValid(connection);
        }));
        let accessPoints = device.get_access_points() || [ ];
        for (let i = 0; i < accessPoints.length; i++) {
            // Access points are grouped by network
            let ap = accessPoints[i];

            if (ap.get_ssid() == null) {
                // hidden access point cannot be added, we need to know
                // the SSID and security details to connect
                // nevertheless, the access point can acquire a SSID when
                // NetworkManager connects to it (via nmcli or the control-center)
                ap._notifySsidId = ap.connect('notify::ssid', Lang.bind(this, this._notifySsidCb));
                continue;
            }

            let pos = this._findNetwork(ap);
            let obj;
            if (pos != -1) {
                obj = this._networks[pos];
                obj.accessPoints.push(ap);
            } else {
                obj = { ssid: ap.get_ssid(),
                        mode: ap.mode,
                        security: this._getApSecurityType(ap),
                        connections: [ ],
                        item: null,
                        accessPoints: [ ap ]
                      };
                obj.ssidText = ssidToLabel(obj.ssid);
                this._networks.push(obj);
            }
            ap._updateId = ap.connect('notify::strength', Lang.bind(this, this._onApStrengthChanged));

            // Check if some connection is valid for this AP
            for (let j = 0; j < validConnections.length; j++) {
                let connection = validConnections[j];
                if (ap.connection_valid(connection) &&
                    obj.connections.indexOf(connection) == -1) {
                    obj.connections.push(connection);
                }
            }
        }

        // Sort APs within each network by strength
        for (let i = 0; i < this._networks.length; i++)
            sortAccessPoints(this._networks[i].accessPoints);

        if (this.device.active_access_point) {
            let networkPos = this._findNetwork(this.device.active_access_point);

            if (networkPos == -1) // the connected access point is invisible
                this._activeNetwork = null;
            else
                this._activeNetwork = this._networks[networkPos];
        } else {
            this._activeNetwork = null;
        }
        this._networks.sort(this._networkSortFunction);

        this._apChangedId = device.connect('notify::active-access-point', Lang.bind(this, this._activeApChanged));
        this._apAddedId = device.connect('access-point-added', Lang.bind(this, this._accessPointAdded));
        this._apRemovedId = device.connect('access-point-removed', Lang.bind(this, this._accessPointRemoved));

        this.parent(client, device, validConnections);
    },

    destroy: function() {
        if (this._apChangedId) {
            // see above for this HACK
            GObject.Object.prototype.disconnect.call(this.device, this._apChangedId);
            this._apChangedId = 0;
        }

        if (this._apAddedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._apAddedId);
            this._apAddedId = 0;
        }

        if (this._apRemovedId) {
            GObject.Object.prototype.disconnect.call(this.device, this._apRemovedId);
            this._apRemovedId = 0;
        }

        this.parent();
    },

    setEnabled: function(enabled) {
        this.statusItem.actor.visible = enabled;
        this.section.actor.visible = enabled;
    },

    activate: function() {
        if (this._activeConnection)
            // nothing to do
            return;

        // among all visible networks, pick the last recently used connection
        let best = null;
        let bestApObj = null;
        let bestTime = 0;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            for (let j = 0; j < apObj.connections.length; j++) {
                let connection = apObj.connections[j];
                if (connection._timestamp > bestTime) {
                    best = connection;
                    bestTime = connection._timestamp;
                    bestApObj = apObj;
                }
            }
        }

        if (best) {
            for (let i = 0; i < bestApObj.accessPoints.length; i++) {
                let ap = bestApObj.accessPoints[i];
                if (ap.connection_valid(best)) {
                    this._client.activate_connection(best, this.device, ap.dbus_path, null);
                    break;
                }
            }
            return;
        }

        // XXX: what else to do?
        // for now, just pick a random network
        // (this function is called in a corner case anyway, that is, only when
        // the user toggles the switch and has more than one wireless device)
        if (this._networks.length > 0) {
            let connection = this._createAutomaticConnection(this._networks[0]);
            let accessPoints = this._networks[0].accessPoints;
            this._client.add_and_activate_connection(connection, this.device, accessPoints[0].dbus_path, null);
        }
    },

    _notifySsidCb: function(accessPoint) {
        if (accessPoint.get_ssid() != null) {
            accessPoint.disconnect(accessPoint._notifySsidId);
            accessPoint._notifySsidId = 0;
            this._accessPointAdded(this.device, accessPoint);
        }
    },

    _activeApChanged: function() {
        this._activeNetwork = null;

        let activeAp = this.device.active_access_point;

        if (activeAp) {
            let res = this._findExistingNetwork(activeAp);

            if (res != null)
                this._activeNetwork = this._networks[res.network];
        }

        // we don't refresh the view here, setActiveConnection will
    },

    _getApSecurityType: function(accessPoint) {
        if (accessPoint._secType)
            return accessPoint._secType;

        let flags = accessPoint.flags;
        let wpa_flags = accessPoint.wpa_flags;
        let rsn_flags = accessPoint.rsn_flags;
        let type;
        if (rsn_flags != NM80211ApSecurityFlags.NONE) {
            /* RSN check first so that WPA+WPA2 APs are treated as RSN/WPA2 */
            if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
	        type = NMAccessPointSecurity.WPA2_ENT;
	    else if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
	        type = NMAccessPointSecurity.WPA2_PSK;
        } else if (wpa_flags != NM80211ApSecurityFlags.NONE) {
            if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
                type = NMAccessPointSecurity.WPA_ENT;
            else if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
	        type = NMAccessPointSecurity.WPA_PSK;
        } else {
            if (flags & NM80211ApFlags.PRIVACY)
                type = NMAccessPointSecurity.WEP;
            else
                type = NMAccessPointSecurity.NONE;
        }

        // cache the found value to avoid checking flags all the time
        accessPoint._secType = type;
        return type;
    },

    _networkSortFunction: function(one, two) {
        let oneHasConnection = one.connections.length != 0;
        let twoHasConnection = two.connections.length != 0;

        // place known connections first
        // (-1 = good order, 1 = wrong order)
        if (oneHasConnection && !twoHasConnection)
            return -1;
        else if (!oneHasConnection && twoHasConnection)
            return 1;

        let oneStrength = one.accessPoints[0].strength;
        let twoStrength = two.accessPoints[0].strength;

        // place stronger connections first
        if (oneStrength != twoStrength)
            return oneStrength < twoStrength ? 1 : -1;

        let oneHasSecurity = one.security != NMAccessPointSecurity.NONE;
        let twoHasSecurity = two.security != NMAccessPointSecurity.NONE;

        // place secure connections first
        // (we treat WEP/WPA/WPA2 the same as there is no way to
        // take them apart from the UI)
        if (oneHasSecurity && !twoHasSecurity)
            return -1;
        else if (!oneHasSecurity && twoHasSecurity)
            return 1;

        // sort alphabetically
        return GLib.utf8_collate(one.ssidText, two.ssidText);
    },

    _networkCompare: function(network, accessPoint) {
        if (!ssidCompare(network.ssid, accessPoint.get_ssid()))
            return false;
        if (network.mode != accessPoint.mode)
            return false;
        if (network.security != this._getApSecurityType(accessPoint))
            return false;

        return true;
    },

    _findExistingNetwork: function(accessPoint) {
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            for (let j = 0; j < apObj.accessPoints.length; j++) {
                if (apObj.accessPoints[j] == accessPoint)
                    return { network: i, ap: j };
            }
        }

        return null;
    },

    _findNetwork: function(accessPoint) {
        if (accessPoint.get_ssid() == null)
            return -1;

        for (let i = 0; i < this._networks.length; i++) {
            if (this._networkCompare(this._networks[i], accessPoint))
                return i;
        }
        return -1;
    },

    _onApStrengthChanged: function(ap) {
        let res = this._findExistingNetwork(ap);
        if (res == null) {
            // Uhm... stale signal?
            return;
        }

        let network = this._networks[res.network];
        network.accessPoints.splice(res.ap, 1);
        Util.insertSorted(network.accessPoints, ap, function(one, two) {
            return two.strength - one.strength;
        });

        this._networks.splice(res.network, 1);
        let newPos = Util.insertSorted(this._networks, network, Lang.bind(this, this._networkSortFunction));

        if (newPos != res.network) {
            this._clearSection();
            this._queueCreateSection();
        }
    },

    _accessPointAdded: function(device, accessPoint) {
        if (accessPoint.get_ssid() == null) {
            // This access point is not visible yet
            // Wait for it to get a ssid
            accessPoint._notifySsidId = accessPoint.connect('notify::ssid', Lang.bind(this, this._notifySsidCb));
            return;
        }

        let pos = this._findNetwork(accessPoint);
        let apObj;
        let needsupdate = false;

        if (pos != -1) {
            apObj = this._networks[pos];
            if (apObj.accessPoints.indexOf(accessPoint) != -1) {
                log('Access point was already seen, not adding again');
                return;
            }

            Util.insertSorted(apObj.accessPoints, accessPoint, function(one, two) {
                return two.strength - one.strength;
            });
            if (apObj.item)
                apObj.item.updateBestAP(apObj.accessPoints[0]);
        } else {
            apObj = { ssid: accessPoint.get_ssid(),
                      mode: accessPoint.mode,
                      security: this._getApSecurityType(accessPoint),
                      connections: [ ],
                      item: null,
                      accessPoints: [ accessPoint ]
                    };
            apObj.ssidText = ssidToLabel(apObj.ssid);
        }
        accessPoint._updateId = accessPoint.connect('notify::strength', Lang.bind(this, this._onApStrengthChanged));

        // check if this enables new connections for this group
        for (let i = 0; i < this._connections.length; i++) {
            let connection = this._connections[i].connection;
            if (accessPoint.connection_valid(connection) &&
                apObj.connections.indexOf(connection) == -1) {
                apObj.connections.push(connection);
            }
        }

        if (pos != -1)
            this._networks.splice(pos, 1);
        let newPos = Util.insertSorted(this._networks, apObj, this._networkSortFunction);

        // Queue an update of the UI if we changed the order
        if (newPos != pos) {
            this._clearSection();
            this._queueCreateSection();
        }
    },

    _accessPointRemoved: function(device, accessPoint) {
        if (accessPoint._updateId) {
            accessPoint.disconnect(accessPoint._updateId);
            accessPoint._updateId = 0;
        }

        let res = this._findExistingNetwork(accessPoint);

        if (res == null) {
            log('Removing an access point that was never added');
            return;
        }

        let apObj = this._networks[res.network];
        apObj.accessPoints.splice(res.ap, 1);

        if (apObj.accessPoints.length == 0) {
            if (this._activeNetwork == apObj)
                this._activeNetwork = null;

            if (apObj.item)
                apObj.item.destroy();

            if (this._overflowItem) {
                if (!apObj.isMore) {
                    // we removed an item in the main menu, and we have a more submenu
                    // we need to extract the first item in more and move it to the submenu

                    let item = this._overflowItem.menu.firstMenuItem;
                    if (item && item._apObj) {
                        item.destroy();
                        // clear the cycle, and allow the construction of the new item
                        item._apObj.item = null;

                        this._createNetworkItem(item._apObj, NUM_VISIBLE_NETWORKS-1);
                    } else {
                        log('The more... menu was existing and empty! This should not happen');
                    }
                }

                // This can happen if the removed connection is from the overflow
                // menu, or if we just moved the last connection out from the menu
                if (this._overflowItem.menu.numMenuItems == 0) {
                    this._overflowItem.destroy();
                    this._overflowItem = null;
                }
            }

            this._networks.splice(res.network, 1);
        } else {
            let okPrev = true, okNext = true;

            if (res.network > 0)
                okPrev = this._networkSortFunction(this._networks[res.network - 1], apObj) >= 0;
            if (res.network < this._networks.length-1)
                okNext = this._networkSortFunction(this._networks[res.network + 1], apObj) <= 0;

            if (!okPrev || !okNext) {
                this._clearSection();
                this._queueCreateSection();
            } else if (apObj.item) {
                apObj.item.updateBestAP(apObj.accessPoints[0]);
            }
        }
    },

    _createAPItem: function(connection, accessPointObj, useConnectionName) {
        let item = new NMNetworkMenuItem(accessPointObj.accessPoints[0], useConnectionName ? connection.get_id() : undefined);
        item._connection = connection;
        item.connect('activate', Lang.bind(this, function() {
            let accessPoints = accessPointObj.accessPoints;
            for (let i = 0; i < accessPoints.length; i++) {
                if (accessPoints[i].connection_valid(connection)) {
                    this._client.activate_connection(connection, this.device, accessPoints[i].dbus_path, null);
                    break;
                }
            }
        }));
        return item;
    },

    _clearSection: function() {
        this.parent();

        for (let i = 0; i < this._networks.length; i++)
            this._networks[i].item = null;
        this._overflowItem = null;
    },

    removeConnection: function(connection) {
        let pos = this._findConnection(connection.get_uuid());
        if (pos == -1) {
            // removing connection that was never added
            return;
        }

        let obj = this._connections[pos];
        this._connections.splice(pos, 1);

        let forceupdate = false;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];
            let connections = apObj.connections;
            for (let k = 0; k < connections.length; k++) {
                if (connections[k].get_uuid() == connection.get_uuid()) {
                    // remove the connection from the access point group
                    connections.splice(k);
                    forceupdate = forceupdate || connections.length == 0;

                    if (forceupdate)
                        break;

                    if (apObj.item) {
                        if (apObj.item instanceof PopupMenu.PopupSubMenuMenuItem) {
                            let items = apObj.item.menu._getMenuItems();
                            if (items.length == 2) {
                                // we need to update the connection list to convert this to a normal item
                                forceupdate = true;
                            } else {
                                for (let j = 0; j < items.length; j++) {
                                    if (items[j]._connection.get_uuid() == connection.get_uuid()) {
                                        items[j].destroy();
                                        break;
                                    }
                                }
                            }
                        } else {
                            apObj.item.destroy();
                            apObj.item = null;
                        }
                    }
                    break;
                }
            }
        }

        if (forceupdate) {
            this._networks.sort(this._networkSortFunction);
            this._clearSection();
            this._queueCreateSection();
        }
    },

    addConnection: function(connection) {
        // record the connection
        let obj = {
            connection: connection,
            name: connection.get_id(),
            uuid: connection.get_uuid(),
        };
        this._connections.push(obj);

        // find an appropriate access point
        let forceupdate = false;
        for (let i = 0; i < this._networks.length; i++) {
            let apObj = this._networks[i];

            // Check if connection is valid for any of these access points
            for (let k = 0; k < apObj.accessPoints.length; k++) {
                let ap = apObj.accessPoints[k];
                if (ap.connection_valid(connection)) {
                    apObj.connections.push(connection);
                    // this potentially changes the sorting order
                    forceupdate = true;
                    break;
                }
            }
        }

        if (forceupdate) {
            this._networks.sort(this._networkSortFunction);
            this._clearSection();
            this._queueCreateSection();
        }
    },

    _createActiveConnectionItem: function() {
        let title;
        if (this._activeConnection && this._activeConnection._connection)
            title = this._activeConnection._connection.get_id();
        else
            title = _("Connected (private)");

        if (this._activeNetwork)
            this._activeConnectionItem = new NMNetworkMenuItem(this.device.active_access_point, undefined,
                                                               { reactive: false });
        else
            this._activeConnectionItem = new PopupMenu.PopupImageMenuItem(title,
                                                                          'network-wireless-connected',
                                                                          { reactive: false });
        this._activeConnectionItem.setShowDot(true);
    },

    _createAutomaticConnection: function(apObj) {
        let name;
        let ssid = NetworkManager.utils_ssid_to_utf8(apObj.ssid);
        if (ssid) {
            /* TRANSLATORS: this the automatic wireless connection name (including the network name) */
            name = _("Auto %s").format(ssid);
        } else
            name = _("Auto wireless");

        let connection = new NetworkManager.Connection();
        connection.add_setting(new NetworkManager.SettingWireless());
        connection.add_setting(new NetworkManager.SettingConnection({
            id: name,
            autoconnect: true, // NetworkManager will know to ignore this if appropriate
            uuid: NetworkManager.utils_uuid_generate(),
            type: NetworkManager.SETTING_WIRELESS_SETTING_NAME
        }));
        return connection;
    },

    _createNetworkItem: function(apObj, position) {
        if(!apObj.accessPoints || apObj.accessPoints.length == 0) {
            // this should not happen, but I have no idea why it happens
            return;
        }

        if(apObj.connections.length > 0) {
            if (apObj.connections.length == 1) {
                apObj.item = this._createAPItem(apObj.connections[0], apObj, false);
            } else {
                let title = apObj.ssidText;
                apObj.item = new PopupMenu.PopupSubMenuMenuItem(title);
                for (let i = 0; i < apObj.connections.length; i++)
                    apObj.item.menu.addMenuItem(this._createAPItem(apObj.connections[i], apObj, true));
            }
        } else {
            apObj.item = new NMNetworkMenuItem(apObj.accessPoints[0]);
            apObj.item.connect('activate', Lang.bind(this, function() {
                let accessPoints = apObj.accessPoints;
                if (   (accessPoints[0]._secType == NMAccessPointSecurity.WPA2_ENT)
                    || (accessPoints[0]._secType == NMAccessPointSecurity.WPA_ENT)) {
                    // 802.1x-enabled APs require further configuration, so they're
                    // handled in gnome-control-center
                    Util.spawn(['gnome-control-center', 'network', 'connect-8021x-wifi',
                                this.device.get_path(), accessPoints[0].dbus_path]);
                } else {
                    let connection = this._createAutomaticConnection(apObj);
                    this._client.add_and_activate_connection(connection, this.device, accessPoints[0].dbus_path, null)
                }
            }));
        }
        apObj.item._apObj = apObj;

        if (position < NUM_VISIBLE_NETWORKS) {
            apObj.isMore = false;
            this.section.addMenuItem(apObj.item, position);
        } else {
            if (!this._overflowItem) {
                this._overflowItem = new PopupMenu.PopupSubMenuMenuItem(_("More..."));
                this.section.addMenuItem(this._overflowItem);
            }
            this._overflowItem.menu.addMenuItem(apObj.item, position - NUM_VISIBLE_NETWORKS);
            apObj.isMore = true;
        }
    },

    _createSection: function() {
        if (!this._shouldShowConnectionList())
            return;

        if (this._activeNetwork) {
            this._createActiveConnectionItem();
            this.section.addMenuItem(this._activeConnectionItem);
        }

        let activeOffset = this._activeConnectionItem ? 1 : 0;

        for(let j = 0; j < this._networks.length; j++) {
            let apObj = this._networks[j];
            if (apObj == this._activeNetwork) {
                activeOffset--;
                continue;
            }

            this._createNetworkItem(apObj, j + activeOffset);
        }
    },
});

const NMApplet = new Lang.Class({
    Name: 'NMApplet',
    Extends: PanelMenu.Button,

    _init: function() {
        this.parent(0.0, _('Network'));

        this._box = new St.BoxLayout({ name: 'networkMenu' });
        this.actor.add_actor (this._box);
        this.actor.add_style_class_name('panel-status-button');

        this._primaryIcon = new St.Icon({ icon_name: 'network-offline',
                                          icon_type: St.IconType.SYMBOLIC,
                                          style_class: 'system-status-icon' });
        this._box.add_actor(this._primaryIcon);

        this._secondaryIcon = new St.Icon({ icon_name: 'network-vpn',
                                            icon_type: St.IconType.SYMBOLIC,
                                            style_class: 'system-status-icon',
                                            visible: false });
        this._box.add_actor(this._secondaryIcon);

        this._client = NMClient.Client.new();

        this._statusSection = new PopupMenu.PopupMenuSection();
        this._statusItem = new PopupMenu.PopupMenuItem('', { style_class: 'popup-inactive-menu-item', reactive: false });
        this._statusSection.addMenuItem(this._statusItem);
        this._statusSection.addAction(_("Enable networking"), Lang.bind(this, function() {
            this._client.networking_enabled = true;
        }));
        this._statusSection.actor.hide();
        this.menu.addMenuItem(this._statusSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._activeConnections = [ ];
        this._connections = [ ];

        this._mainConnection = null;
        this._vpnConnection = null;
        this._activeAccessPointUpdateId = 0;
        this._activeAccessPoint = null;
        this._mobileUpdateId = 0;
        this._mobileUpdateDevice = null;

        this._devices = { };

        this._devices.wired = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
            item: new NMWiredSectionTitleMenuItem(_("Wired"))
        };

        this._devices.wired.section.addMenuItem(this._devices.wired.item);
        this._devices.wired.section.actor.hide();
        this.menu.addMenuItem(this._devices.wired.section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._devices.wireless = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
            item: this._makeToggleItem('wireless', _("Wireless"))
        };
        this._devices.wireless.section.addMenuItem(this._devices.wireless.item);
        this._devices.wireless.section.actor.hide();
        this.menu.addMenuItem(this._devices.wireless.section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._devices.wwan = {
            section: new PopupMenu.PopupMenuSection(),
            devices: [ ],
            item: this._makeToggleItem('wwan', _("Mobile broadband"))
        };
        this._devices.wwan.section.addMenuItem(this._devices.wwan.item);
        this._devices.wwan.section.actor.hide();
        this.menu.addMenuItem(this._devices.wwan.section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._devices.vpn = {
            section: new PopupMenu.PopupMenuSection(),
            device: this._makeWrapperDevice(NMDeviceVPN, null),
            item: new NMWiredSectionTitleMenuItem(_("VPN Connections"))
        };
        this._devices.vpn.section.addMenuItem(this._devices.vpn.item);
        this._devices.vpn.section.addMenuItem(this._devices.vpn.device.section);
        this._devices.vpn.section.actor.hide();
        this.menu.addMenuItem(this._devices.vpn.section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_("Network Settings"), 'gnome-network-panel.desktop');

        // Device types
        this._dtypes = { };
        this._dtypes[NetworkManager.DeviceType.ETHERNET] = NMDeviceWired;
        this._dtypes[NetworkManager.DeviceType.WIFI] = NMDeviceWireless;
        this._dtypes[NetworkManager.DeviceType.MODEM] = NMDeviceModem;
        this._dtypes[NetworkManager.DeviceType.BT] = NMDeviceBluetooth;
        // TODO: WiMax support

        // Connection types
        this._ctypes = { };
        this._ctypes[NetworkManager.SETTING_WIRELESS_SETTING_NAME] = NMConnectionCategory.WIRELESS;
        this._ctypes[NetworkManager.SETTING_WIRED_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_PPPOE_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_PPP_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_BLUETOOTH_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_CDMA_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_GSM_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_VPN_SETTING_NAME] = NMConnectionCategory.VPN;

        this._settings = NMClient.RemoteSettings.new(null);
        this._connectionsReadId = this._settings.connect('connections-read', Lang.bind(this, function() {
            this._readConnections();
            this._readDevices();
            this._syncNMState();

            // Connect to signals late so that early signals don't find in inconsistent state
            // and connect only once (this signal handler can be called again if NetworkManager goes up and down)
            if (!this._inited) {
                this._inited = true;
                this._client.connect('notify::manager-running', Lang.bind(this, this._syncNMState));
                this._client.connect('notify::networking-enabled', Lang.bind(this, this._syncNMState));
                this._client.connect('notify::state', Lang.bind(this, this._syncNMState));
                this._client.connect('notify::active-connections', Lang.bind(this, this._updateIcon));
                this._client.connect('device-added', Lang.bind(this, this._deviceAdded));
                this._client.connect('device-removed', Lang.bind(this, this._deviceRemoved));
                this._settings.connect('new-connection', Lang.bind(this, this._newConnection));
            }
        }));
    },

    setIcon: function(iconName) {
        this._primaryIcon.icon_name = iconName;
    },

    setLockedState: function(locked) {
        // FIXME: more design discussion is needed before we can
        // expose part of this menu

        if (locked)
            this.menu.close();
        this.actor.reactive = !locked;
    },

    _ensureSource: function() {
        if (!this._source) {
            this._source = new MessageTray.Source(_("Network Manager"),
                                                  'network-transmit-receive',
                                                  St.IconType.SYMBOLIC);

            this._source.connect('destroy', Lang.bind(this, function() {
                this._source = null;
            }));
            Main.messageTray.add(this._source);
        }
    },

    _makeToggleItem: function(type, title) {
        let item = new NMWirelessSectionTitleMenuItem(this._client, type, title);
        item.connect('enabled-changed', Lang.bind(this, function(item, enabled) {
            let devices = this._devices[type].devices;
            devices.forEach(function(dev) {
                dev.setEnabled(enabled);
            });
            this._syncSectionTitle(type);
        }));
        return item;
    },

    _syncSectionTitle: function(category) {
        if (category == NMConnectionCategory.VPN) {
            // Special case VPN: it's only one device (and a fake one
            // actually), and we don't show it if empty
            let device = this._devices.vpn.device;
            let section = this._devices.vpn.section;
            let item = this._devices.vpn.item;

            section.actor.visible = !device.empty;
            item.updateForDevice(device);
            return;
        }

        let devices = this._devices[category].devices;
        let item = this._devices[category].item;
        let section = this._devices[category].section;
        if (devices.length == 0)
            section.actor.hide();
        else {
            section.actor.show();
            if (devices.length == 1) {
                let dev = devices[0];
                dev.statusItem.actor.hide();
                item.updateForDevice(dev);
            } else {
                devices.forEach(function(dev) {
                    dev.statusItem.actor.show();
                });
                // remove status text from the section title item
                item.updateForDevice(null);
            }
        }
    },

    _readDevices: function() {
        let devices = this._client.get_devices() || [ ];
        for (let i = 0; i < devices.length; ++i) {
            this._deviceAdded(this._client, devices[i]);
        }
    },

    _notifyForDevice: function(device, iconName, title, text, urgency) {
        if (device._notification)
            device._notification.destroy();

        /* must call after destroying previous notification,
           or this._source will be cleared */
        this._ensureSource();

        let icon = new St.Icon({ icon_name: iconName,
                                 icon_type: St.IconType.SYMBOLIC,
                                 icon_size: this._source.ICON_SIZE
                               });
        device._notification = new MessageTray.Notification(this._source, title, text,
                                                            { icon: icon });
        device._notification.setUrgency(urgency);
        device._notification.setTransient(true);
        device._notification.connect('destroy', function() {
            device._notification = null;
        });
        this._source.notify(device._notification);
    },

    _makeWrapperDevice: function(wrapperClass, device) {
        let wrapper = new wrapperClass(this._client, device, this._connections);

        wrapper._activationFailedId = wrapper.connect('activation-failed', Lang.bind(this, function(device, reason) {
            // XXX: nm-applet has no special text depending on reason
            // but I'm not sure of this generic message
            this._notifyForDevice(device, 'network-error',
                                  _("Connection failed"),
                                  _("Activation of network connection failed"),
                                  MessageTray.Urgency.HIGH);
        }));
        wrapper._deviceStateChangedId = wrapper.connect('state-changed', Lang.bind(this, function(dev) {
            this._syncSectionTitle(dev.category);
        }));
        wrapper._destroyId = wrapper.connect('destroy', function(wrapper) {
            wrapper.disconnect(wrapper._activationFailedId);
            wrapper.disconnect(wrapper._deviceStateChangedId);
            wrapper.disconnect(wrapper._destroyId);
        });

        return wrapper;
    },

    _deviceAdded: function(client, device) {
        if (device._delegate) {
            // already seen, not adding again
            return;
        }
        let wrapperClass = this._dtypes[device.get_device_type()];
        if (wrapperClass) {
            let wrapper = this._makeWrapperDevice(wrapperClass, device);

            let section = this._devices[wrapper.category].section;
            let devices = this._devices[wrapper.category].devices;

            section.addMenuItem(wrapper.section, 1);
            section.addMenuItem(wrapper.statusItem, 1);
            devices.push(wrapper);

            this._syncSectionTitle(wrapper.category);
        } else
            log('Invalid network device type, is ' + device.get_device_type());
    },

    _deviceRemoved: function(client, device) {
        if (!device._delegate) {
            log('Removing a network device that was not added');
            return;
        }

        let wrapper = device._delegate;
        wrapper.destroy();

        let devices = this._devices[wrapper.category].devices;
        let pos = devices.indexOf(wrapper);
        devices.splice(pos, 1);

        this._syncSectionTitle(wrapper.category)
    },

    _syncActiveConnections: function() {
        let closedConnections = [ ];
        let newActiveConnections = this._client.get_active_connections() || [ ];
        for (let i = 0; i < this._activeConnections.length; i++) {
            let a = this._activeConnections[i];
            if (newActiveConnections.indexOf(a) == -1) // connection is removed
                closedConnections.push(a);
        }

        for (let i = 0; i < closedConnections.length; i++) {
            let active = closedConnections[i];
            if (active._primaryDevice) {
                active._primaryDevice.setActiveConnection(null);
                active._primaryDevice = null;
            }
            if (active._inited) {
                active.disconnect(active._notifyStateId);
                active.disconnect(active._notifyDefaultId);
                active.disconnect(active._notifyDefault6Id);
                active._inited = false;
            }
        }

        this._activeConnections = newActiveConnections;
        this._mainConnection = null;
        this._vpnConnection = null;

        let activating = null;
        let default_ip4 = null;
        let default_ip6 = null;
        let active_vpn = null;
        for (let i = 0; i < this._activeConnections.length; i++) {
            let a = this._activeConnections[i];

            if (!a._inited) {
                a._notifyDefaultId = a.connect('notify::default', Lang.bind(this, this._updateIcon));
                a._notifyDefault6Id = a.connect('notify::default6', Lang.bind(this, this._updateIcon));
                a._notifyStateId = a.connect('notify::state', Lang.bind(this, this._notifyActivated));

                a._inited = true;
            }

            if (!a._connection) {
                a._connection = this._settings.get_connection_by_path(a.connection);

                if (a._connection) {
                    a._type = a._connection._type;
                    a._section = this._ctypes[a._type];
                } else {
                    a._connection = null;
                    a._type = null;
                    a._section = null;
                    log('Cannot find connection for active (or connection cannot be read)');
                }
            }

            if (a['default'])
                default_ip4 = a;
            if (a.default6)
                default_ip6 = a;

            if (a._type == 'vpn')
                active_vpn = a;
            else if (a.state == NetworkManager.ActiveConnectionState.ACTIVATING)
                activating = a;

            if (!a._primaryDevice) {
                if (a._type != NetworkManager.SETTING_VPN_SETTING_NAME) {
                    // find a good device to be considered primary
                    a._primaryDevice = null;
                    let devices = a.get_devices() || [];
                    for (let j = 0; j < devices.length; j++) {
                        let d = devices[j];
                        if (d._delegate) {
                            a._primaryDevice = d._delegate;
                            break;
                        }
                    }
                } else
                    a._primaryDevice = this._devices.vpn.device

                if (a._primaryDevice)
                    a._primaryDevice.setActiveConnection(a);

                if (a.state == NetworkManager.ActiveConnectionState.ACTIVATED
                    && a._primaryDevice && a._primaryDevice._notification) {
                    a._primaryDevice._notification.destroy();
                    a._primaryDevice._notification = null;
                }
            }
        }

        this._mainConnection = activating || default_ip4 || default_ip6 || this._activeConnections[0] || null;
        this._vpnConnection = active_vpn;
    },

    _notifyActivated: function(activeConnection) {
        if (activeConnection.state == NetworkManager.ActiveConnectionState.ACTIVATED
            && activeConnection._primaryDevice && activeConnection._primaryDevice._notification) {
            activeConnection._primaryDevice._notification.destroy();
            activeConnection._primaryDevice._notification = null;
        }

        this._updateIcon();
    },

    _readConnections: function() {
        let connections = this._settings.list_connections();
        for (let i = 0; i < connections.length; i++) {
            let connection = connections[i];
            if (connection._updatedId) {
                // connection was already seen (for example because NetworkManager was restarted)
                continue;
            }
            connection._removedId = connection.connect('removed', Lang.bind(this, this._connectionRemoved));
            connection._updatedId = connection.connect('updated', Lang.bind(this, this._updateConnection));

            this._updateConnection(connection);
            this._connections.push(connection);
        }
    },

    _newConnection: function(settings, connection) {
        if (connection._updatedId) {
            // connection was already seen
            return;
        }

        connection._removedId = connection.connect('removed', Lang.bind(this, this._connectionRemoved));
        connection._updatedId = connection.connect('updated', Lang.bind(this, this._updateConnection));

        this._updateConnection(connection);
        this._connections.push(connection);

        this._updateIcon();
    },

    _connectionRemoved: function(connection) {
        let pos = this._connections.indexOf(connection);
        if (pos != -1)
            this._connections.splice(connection);

        let section = connection._section;

        if (section == NMConnectionCategory.VPN) {
            this._devices.vpn.device.removeConnection(connection);
            this._syncSectionTitle(section);
        } else if (section != NMConnectionCategory.INVALID) {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++)
                devices[i].removeConnection(connection);
        }

        connection.disconnect(connection._removedId);
        connection.disconnect(connection._updatedId);
        connection._removedId = connection._updatedId = 0;
    },

    _updateConnection: function(connection) {
        let connectionSettings = connection.get_setting_by_name(NetworkManager.SETTING_CONNECTION_SETTING_NAME);
        connection._type = connectionSettings.type;
        connection._section = this._ctypes[connection._type] || NMConnectionCategory.INVALID;
        connection._timestamp = connectionSettings.timestamp;

        let section = connection._section;

        if (section == NMConnectionCategory.INVALID)
            return;
        if (section == NMConnectionCategory.VPN) {
            this._devices.vpn.device.checkConnection(connection);
            this._syncSectionTitle(section);
        } else {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++) {
                devices[i].checkConnection(connection);
            }
        }
    },

    _hideDevices: function() {
        this._devicesHidden = true;

        for (let category in this._devices)
            this._devices[category].section.actor.hide();
    },

    _showNormal: function() {
        if (!this._devicesHidden) // nothing to do
            return;
        this._devicesHidden = false;

        this._statusSection.actor.hide();

        this._syncSectionTitle(NMConnectionCategory.WIRED);
        this._syncSectionTitle(NMConnectionCategory.WIRELESS);
        this._syncSectionTitle(NMConnectionCategory.WWAN);
        this._syncSectionTitle(NMConnectionCategory.VPN);
    },

    _syncNMState: function() {
        if (!this._client.manager_running) {
            log('NetworkManager is not running, hiding...');
            this.menu.close();
            this.actor.hide();
            return;
        } else
            this.actor.show();

        if (!this._client.networking_enabled) {
            this.setIcon('network-offline');
            this._hideDevices();
            this._statusItem.label.text = _("Networking is disabled");
            this._statusSection.actor.show();
            return;
        }

        this._showNormal();
        this._updateIcon();
    },

    _updateIcon: function() {
        this._syncActiveConnections();
        let mc = this._mainConnection;
        let hasApIcon = false;
        let hasMobileIcon = false;

        if (!mc) {
            this.setIcon('network-offline');
        } else if (mc.state == NetworkManager.ActiveConnectionState.ACTIVATING) {
            switch (mc._section) {
            case NMConnectionCategory.WWAN:
                this.setIcon('network-cellular-acquiring');
                break;
            case NMConnectionCategory.WIRELESS:
                this.setIcon('network-wireless-acquiring');
                break;
            case NMConnectionCategory.WIRED:
                this.setIcon('network-wired-acquiring');
                break;
            default:
                // fallback to a generic connected icon
                // (it could be a private connection of some other user)
                this.setIcon('network-wired-acquiring');
            }
        } else {
            let dev;
            switch (mc._section) {
            case NMConnectionCategory.WIRELESS:
                dev = mc._primaryDevice;
                if (dev) {
                    let ap = dev.device.active_access_point;
                    let mode = dev.device.mode;
                    if (!ap) {
                        if (mode != NM80211Mode.ADHOC) {
                            log('An active wireless connection, in infrastructure mode, involves no access point?');
                            break;
                        }
                        this.setIcon('network-wireless-connected');
                    } else {
                        if (this._activeAccessPoint != ap) {
                            if (this._accessPointUpdateId)
                                this._activeAccessPoint.disconnect(this._accessPointUpdateId);
                            this._activeAccessPoint = ap;
                            this._activeAccessPointUpdateId = ap.connect('notify::strength', Lang.bind(this, function() {
                                this.setIcon('network-wireless-signal-' + signalToIcon(ap.strength));
                            }));
                        }
                        this.setIcon('network-wireless-signal-' + signalToIcon(ap.strength));
                        hasApIcon = true;
                    }
                    break;
                } else {
                    log('Active connection with no primary device?');
                    break;
                }
            case NMConnectionCategory.WIRED:
                this.setIcon('network-wired');
                break;
            case NMConnectionCategory.WWAN:
                dev = mc._primaryDevice;
                if (!dev) {
                    log('Active connection with no primary device?');
                    break;
                }
                if (!dev.mobileDevice) {
                    // this can happen for bluetooth in PAN mode
                    this.setIcon('network-cellular-connected');
                    break;
                }

                if (dev.mobileDevice != this._mobileUpdateDevice) {
                    if (this._mobileUpdateId)
                        this._mobileUpdateDevice.disconnect(this._mobileUpdateId);
                    this._mobileUpdateDevice = dev.mobileDevice;
                    this._mobileUpdateId = dev.mobileDevice.connect('notify::signal-quality', Lang.bind(this, function() {
                        this.setIcon('network-cellular-signal-' + signalToIcon(dev.mobileDevice.signal_quality));
                    }));
                }
                this.setIcon('network-cellular-signal-' + signalToIcon(dev.mobileDevice.signal_quality));
                hasMobileIcon = true;
                break;
            default:
                // fallback to a generic connected icon
                // (it could be a private connection of some other user)
                this.setIcon('network-wired');
                break;
            }
        }

        // update VPN indicator
        if (this._vpnConnection) {
            let vpnIconName = 'network-vpn';
            if (this._vpnConnection.state == NetworkManager.ActiveConnectionState.ACTIVATING)
                vpnIconName = 'network-vpn-acquiring';

            // only show a separate icon when we're using a wireless/3g connection
            if (mc._section == NMConnectionCategory.WIRELESS || 
                mc._section == NMConnectionCategory.WWAN) {
                this._secondaryIcon.icon_name = vpnIconName;
                this._secondaryIcon.visible = true;
            } else {
                this.setIcon(vpnIconName);
                this._secondaryIcon.visible = false;
            }
        } else {
            this._secondaryIcon.visible = false;
        }

        // cleanup stale signal connections

        if (!hasApIcon && this._activeAccessPointUpdateId) {
            this._activeAccessPoint.disconnect(this._activeAccessPointUpdateId);
            this._activeAccessPoint = null;
            this._activeAccessPointUpdateId = 0;
        }
        if (!hasMobileIcon && this._mobileUpdateId) {
            this._mobileUpdateDevice.disconnect(this._mobileUpdateId);
            this._mobileUpdateDevice = null;
            this._mobileUpdateId = 0;
        }
    }
});
