// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Params = imports.misc.params;

const Shell = imports.gi.Shell;
const Main = imports.ui.main;
const ShellMountOperation = imports.ui.shellMountOperation;
const GnomeSession = imports.misc.gnomeSession;

const GNOME_SESSION_AUTOMOUNT_INHIBIT = 16;

// GSettings keys
const SETTINGS_SCHEMA = 'org.gnome.desktop.media-handling';
const SETTING_ENABLE_AUTOMOUNT = 'automount';

const AUTORUN_EXPIRE_TIMEOUT_SECS = 10;

const ConsoleKitSessionIface = <interface name="org.freedesktop.ConsoleKit.Session">
<method name="IsActive">
    <arg type="b" direction="out" />
</method>
<signal name="ActiveChanged">
    <arg type="b" direction="out" />
</signal>
</interface>;

const ConsoleKitSessionProxy = Gio.DBusProxy.makeProxyWrapper(ConsoleKitSessionIface);

const ConsoleKitManagerIface = <interface name="org.freedesktop.ConsoleKit.Manager">
<method name="GetCurrentSession">
    <arg type="o" direction="out" />
</method>
</interface>;

const ConsoleKitManagerInfo = Gio.DBusInterfaceInfo.new_for_xml(ConsoleKitManagerIface);

function ConsoleKitManager() {
    var self = new Gio.DBusProxy({ g_connection: Gio.DBus.system,
				   g_interface_name: ConsoleKitManagerInfo.name,
				   g_interface_info: ConsoleKitManagerInfo,
				   g_name: 'org.freedesktop.ConsoleKit',
				   g_object_path: '/org/freedesktop/ConsoleKit/Manager',
                                   g_flags: (Gio.DBusProxyFlags.DO_NOT_AUTO_START |
                                             Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES) });

    self._updateSessionActive = function() {
        if (self.g_name_owner) {
            self.GetCurrentSessionRemote(function([session]) {
                self._ckSession = new ConsoleKitSessionProxy(Gio.DBus.system, 'org.freedesktop.ConsoleKit', session);

                self._ckSession.connectSignal('ActiveChanged', function(object, senderName, [isActive]) {
                    self.sessionActive = isActive;
                });
                self._ckSession.IsActiveRemote(function([isActive]) {
                    self.sessionActive = isActive;
                });
            });
        } else {
            self.sessionActive = true;
        }
    };
    self.connect('notify::g-name-owner',
                 Lang.bind(self, self._updateSessionActive));

    self._updateSessionActive();
    self.init(null);
    return self;
}

function haveSystemd() {
    return GLib.access("/sys/fs/cgroup/systemd", 0) >= 0;
}

const AutomountManager = new Lang.Class({
    Name: 'AutomountManager',

    _init: function() {
        this._settings = new Gio.Settings({ schema: SETTINGS_SCHEMA });
        this._volumeQueue = [];
        this._session = new GnomeSession.SessionManager();
        this._session.connectSignal('InhibitorAdded',
                                    Lang.bind(this, this._InhibitorsChanged));
        this._session.connectSignal('InhibitorRemoved',
                                    Lang.bind(this, this._InhibitorsChanged));
        this._inhibited = false;

        if (!haveSystemd())
            this.ckListener = new ConsoleKitManager();

        Main.screenShield.connect('lock-status-changed', Lang.bind(this, this._lockStatusChanged));

        this._volumeMonitor = Gio.VolumeMonitor.get();

        this._volumeMonitor.connect('volume-added',
                                    Lang.bind(this,
                                              this._onVolumeAdded));
        this._volumeMonitor.connect('volume-removed',
                                    Lang.bind(this,
                                              this._onVolumeRemoved));
        this._volumeMonitor.connect('drive-connected',
                                    Lang.bind(this,
                                              this._onDriveConnected));
        this._volumeMonitor.connect('drive-disconnected',
                                    Lang.bind(this,
                                              this._onDriveDisconnected));
        this._volumeMonitor.connect('drive-eject-button',
                                    Lang.bind(this,
                                              this._onDriveEjectButton));

        Mainloop.idle_add(Lang.bind(this, this._startupMountAll));
    },

    _InhibitorsChanged: function(object, senderName, [inhibtor]) {
        this._session.IsInhibitedRemote(GNOME_SESSION_AUTOMOUNT_INHIBIT,
            Lang.bind(this,
                function(result, error) {
                    if (!error) {
                        this._inhibited = result[0];
                    }
                }));
    },

    _lockStatusChanged: function(shield, locked) {
        if (!locked) {
            this._volumeQueue.forEach(Lang.bind(this, function(volume) {
                this._checkAndMountVolume(volume);
            }));
        }

        // clear the queue anyway
        this._volumeQueue = [];
    },

    _startupMountAll: function() {
        let volumes = this._volumeMonitor.get_volumes();
        volumes.forEach(Lang.bind(this, function(volume) {
            this._checkAndMountVolume(volume, { checkSession: false,
                                                useMountOp: false,
                                                allowAutorun: false });
        }));

        return false;
    },

    isSessionActive: function() {
        // Return whether the current session is active, using the
        // right mechanism: either systemd if available or ConsoleKit
        // as fallback.

        if (haveSystemd())
            return Shell.session_is_active_for_systemd();

        return this.ckListener.sessionActive;
    },

    _onDriveConnected: function() {
        // if we're not in the current ConsoleKit session,
        // or screensaver is active, don't play sounds
        if (!this.isSessionActive())
            return;

        if (Main.screenShield.locked)
            return;

        global.play_theme_sound(0, 'device-added-media');
    },

    _onDriveDisconnected: function() {
        // if we're not in the current ConsoleKit session,
        // or screensaver is active, don't play sounds
        if (!this.isSessionActive())
            return;

        if (Main.screenShield.locked)
            return;

        global.play_theme_sound(0, 'device-removed-media');        
    },

    _onDriveEjectButton: function(monitor, drive) {
        // TODO: this code path is not tested, as the GVfs volume monitor
        // doesn't emit this signal just yet.
        if (!this.isSessionActive())
            return;

        // we force stop/eject in this case, so we don't have to pass a
        // mount operation object
        if (drive.can_stop()) {
            drive.stop
                (Gio.MountUnmountFlags.FORCE, null, null,
                 Lang.bind(this, function(drive, res) {
                     try {
                         drive.stop_finish(res);
                     } catch (e) {
                         log("Unable to stop the drive after drive-eject-button " + e.toString());
                     }
                 }));
        } else if (drive.can_eject()) {
            drive.eject_with_operation 
                (Gio.MountUnmountFlags.FORCE, null, null,
                 Lang.bind(this, function(drive, res) {
                     try {
                         drive.eject_with_operation_finish(res);
                     } catch (e) {
                         log("Unable to eject the drive after drive-eject-button " + e.toString());
                     }
                 }));
        }
    },

    _onVolumeAdded: function(monitor, volume) {
        this._checkAndMountVolume(volume);
    },

    _checkAndMountVolume: function(volume, params) {
        params = Params.parse(params, { checkSession: true,
                                        useMountOp: true,
                                        allowAutorun: true });

        if (params.checkSession) {
            // if we're not in the current ConsoleKit session,
            // don't attempt automount
            if (!this.isSessionActive())
                return;

            if (Main.screenShield.locked) {
                if (this._volumeQueue.indexOf(volume) == -1)
                    this._volumeQueue.push(volume);

                return;
            }
        }

        if (this._inhibited)
            return;

        // Volume is already mounted, don't bother.
        if (volume.get_mount())
            return;

        if (!this._settings.get_boolean(SETTING_ENABLE_AUTOMOUNT) ||
            !volume.should_automount() ||
            !volume.can_mount()) {
            // allow the autorun to run anyway; this can happen if the
            // mount gets added programmatically later, even if 
            // should_automount() or can_mount() are false, like for
            // blank optical media.
            this._allowAutorun(volume);
            this._allowAutorunExpire(volume);

            return;
        }

        if (params.useMountOp) {
            let operation = new ShellMountOperation.ShellMountOperation(volume);
            this._mountVolume(volume, operation, params.allowAutorun);
        } else {
            this._mountVolume(volume, null, params.allowAutorun);
        }
    },

    _mountVolume: function(volume, operation, allowAutorun) {
        if (allowAutorun)
            this._allowAutorun(volume);

        let mountOp = operation ? operation.mountOp : null;
        volume._operation = operation;

        volume.mount(0, mountOp, null,
                     Lang.bind(this, this._onVolumeMounted));
    },

    _onVolumeMounted: function(volume, res) {
        this._allowAutorunExpire(volume);

        try {
            volume.mount_finish(res);
            this._closeOperation(volume);
        } catch (e) {
            // FIXME: we will always get G_IO_ERROR_FAILED from the gvfs udisks
            // backend in this case, see 
            // https://bugs.freedesktop.org/show_bug.cgi?id=51271
            if (e.message.indexOf('No key available with this passphrase') != -1) {
                this._reaskPassword(volume);
            } else {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED_HANDLED))
                    log('Unable to mount volume ' + volume.get_name() + ': ' + e.toString());

                this._closeOperation(volume);
            }
        }
    },

    _onVolumeRemoved: function(monitor, volume) {
        this._volumeQueue = 
            this._volumeQueue.filter(function(element) {
                return (element != volume);
            });
    },

    _reaskPassword: function(volume) {
        let existingDialog = volume._operation ? volume._operation.borrowDialog() : null;
        let operation = 
            new ShellMountOperation.ShellMountOperation(volume,
                                                        { existingDialog: existingDialog });
        this._mountVolume(volume, operation);
    },

    _closeOperation: function(volume) {
        if (volume._operation)
            volume._operation.close();
    },

    _allowAutorun: function(volume) {
        volume.allowAutorun = true;
    },

    _allowAutorunExpire: function(volume) {
        Mainloop.timeout_add_seconds(AUTORUN_EXPIRE_TIMEOUT_SECS, function() {
            volume.allowAutorun = false;
            return false;
        });
    }
});
