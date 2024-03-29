// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const Config = imports.misc.config;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Params = imports.misc.params;
const Util = imports.misc.util;

let nextNotificationId = 1;

// Should really be defined in Gio.js
const BusIface = <interface name="org.freedesktop.DBus">
<method name="GetConnectionUnixProcessID">
    <arg type="s" direction="in" />
    <arg type="u" direction="out" />
</method>
</interface>;

var BusProxy = Gio.DBusProxy.makeProxyWrapper(BusIface);
function Bus() {
    return new BusProxy(Gio.DBus.session, 'org.freedesktop.DBus', '/org/freedesktop/DBus');
}

const NotificationDaemonIface = <interface name="org.freedesktop.Notifications">
<method name="Notify">
    <arg type="s" direction="in"/>
    <arg type="u" direction="in"/>
    <arg type="s" direction="in"/>
    <arg type="s" direction="in"/>
    <arg type="s" direction="in"/>
    <arg type="as" direction="in"/>
    <arg type="a{sv}" direction="in"/>
    <arg type="i" direction="in"/>
    <arg type="u" direction="out"/>
</method>
<method name="CloseNotification">
    <arg type="u" direction="in"/>
</method>
<method name="GetCapabilities">
    <arg type="as" direction="out"/>
</method>
<method name="GetServerInformation">
    <arg type="s" direction="out"/>
    <arg type="s" direction="out"/>
    <arg type="s" direction="out"/>
    <arg type="s" direction="out"/>
</method>
<signal name="NotificationClosed">
    <arg type="u"/>
    <arg type="u"/>
</signal>
<signal name="ActionInvoked">
    <arg type="u"/>
    <arg type="s"/>
</signal>
</interface>;

const NotificationClosedReason = {
    EXPIRED: 1,
    DISMISSED: 2,
    APP_CLOSED: 3,
    UNDEFINED: 4
};

const Urgency = {
    LOW: 0,
    NORMAL: 1,
    CRITICAL: 2
};

const rewriteRules = {
    'XChat': [
        { pattern:     /^XChat: Private message from: (\S*) \(.*\)$/,
          replacement: '<$1>' },
        { pattern:     /^XChat: New public message from: (\S*) \((.*)\)$/,
          replacement: '$2 <$1>' },
        { pattern:     /^XChat: Highlighted message from: (\S*) \((.*)\)$/,
          replacement: '$2 <$1>' }
    ]
};

const NotificationDaemon = new Lang.Class({
    Name: 'NotificationDaemon',

    _init: function() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(NotificationDaemonIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/freedesktop/Notifications');

        this._sources = [];
        this._senderToPid = {};
        this._notifications = {};
        this._busProxy = new Bus();

        Main.statusIconDispatcher.connect('message-icon-added', Lang.bind(this, this._onTrayIconAdded));
        Main.statusIconDispatcher.connect('message-icon-removed', Lang.bind(this, this._onTrayIconRemoved));

        Shell.WindowTracker.get_default().connect('notify::focus-app',
            Lang.bind(this, this._onFocusAppChanged));
        Main.overview.connect('hidden',
            Lang.bind(this, this._onFocusAppChanged));
    },

    _iconForNotificationData: function(icon, hints) {
        // If an icon is not specified, we use 'image-data' or 'image-path' hint for an icon
        // and don't show a large image. There are currently many applications that use
        // notify_notification_set_icon_from_pixbuf() from libnotify, which in turn sets
        // the 'image-data' hint. These applications don't typically pass in 'app_icon'
        // argument to Notify() and actually expect the pixbuf to be shown as an icon.
        // So the logic here does the right thing for this case. If both an icon and either
        // one of 'image-data' or 'image-path' are specified, we show both an icon and
        // a large image.
        if (icon) {
            if (icon.substr(0, 7) == 'file://')
                return new Gio.FileIcon({ file: Gio.File.new_for_uri(icon) });
            else if (icon[0] == '/') {
                return new Gio.FileIcon({ file: Gio.File.new_for_path(icon) });
            } else
                return new Gio.ThemedIcon({ name: icon });
        } else if (hints['image-data']) {
            let [width, height, rowStride, hasAlpha,
                 bitsPerSample, nChannels, data] = hints['image-data'];
            return Shell.util_create_pixbuf_from_data(data, GdkPixbuf.Colorspace.RGB, hasAlpha,
                                                      bitsPerSample, width, height, rowStride);
        } else if (hints['image-path']) {
            return new Gio.FileIcon({ file: Gio.File.new_for_path(hints['image-path']) });
        } else {
            let stockIcon;
            switch (hints.urgency) {
                case Urgency.LOW:
                case Urgency.NORMAL:
                    stockIcon = 'gtk-dialog-info';
                    break;
                case Urgency.CRITICAL:
                    stockIcon = 'gtk-dialog-error';
                    break;
            }
            return new Gio.ThemedIcon({ name: stockIcon });
        }
    },

    _lookupSource: function(title, pid, trayIcon) {
        for (let i = 0; i < this._sources.length; i++) {
            let source = this._sources[i];
            if (source.pid == pid &&
                (source.initialTitle == title || source.trayIcon || trayIcon))
                return source;
        }
        return null;
    },

    // Returns the source associated with ndata.notification if it is set.
    // Otherwise, returns the source associated with the title and pid if
    // such source is stored in this._sources and the notification is not
    // transient. If the existing or requested source is associated with
    // a tray icon and passed in pid matches a pid of an existing source,
    // the title match is ignored to enable representing a tray icon and
    // notifications from the same application with a single source.
    //
    // If no existing source is found, a new source is created as long as
    // pid is provided.
    //
    // Either a pid or ndata.notification is needed to retrieve or
    // create a source.
    _getSource: function(title, pid, ndata, sender, trayIcon) {
        if (!pid && !(ndata && ndata.notification))
            return null;

        // We use notification's source for the notifications we still have
        // around that are getting replaced because we don't keep sources
        // for transient notifications in this._sources, but we still want
        // the notification associated with them to get replaced correctly.
        if (ndata && ndata.notification)
            return ndata.notification.source;

        let isForTransientNotification = (ndata && ndata.hints['transient'] == true);

        // We don't want to override a persistent notification
        // with a transient one from the same sender, so we
        // always create a new source object for new transient notifications
        // and never add it to this._sources .
        if (!isForTransientNotification) {
            let source = this._lookupSource(title, pid, trayIcon);
            if (source) {
                source.setTitle(title);
                return source;
            }
        }

        let source = new Source(title, pid, sender, trayIcon);
        source.setTransient(isForTransientNotification);

        if (!isForTransientNotification) {
            this._sources.push(source);
            source.connect('destroy', Lang.bind(this,
                function() {
                    let index = this._sources.indexOf(source);
                    if (index >= 0)
                        this._sources.splice(index, 1);
                }));
        }

        Main.messageTray.add(source);
        return source;
    },

    NotifyAsync: function(params, invocation) {
        let [appName, replacesId, icon, summary, body, actions, hints, timeout] = params;
        let id;

        for (let hint in hints) {
            // unpack the variants
            hints[hint] = hints[hint].deep_unpack();
        }

        hints = Params.parse(hints, { urgency: Urgency.NORMAL }, true);

        // Filter out chat, presence, calls and invitation notifications from
        // Empathy, since we handle that information from telepathyClient.js
        if (appName == 'Empathy' && (hints['category'] == 'im.received' ||
              hints['category'] == 'x-empathy.im.room-invitation' ||
              hints['category'] == 'x-empathy.call.incoming' ||
              hints['category'] == 'x-empathy.transfer.incoming' ||
              hints['category'] == 'x-empathy.im.subscription-request' ||
              hints['category'] == 'presence.online' ||
              hints['category'] == 'presence.offline')) {
            // Ignore replacesId since we already sent back a
            // NotificationClosed for that id.
            id = nextNotificationId++;
            Mainloop.idle_add(Lang.bind(this,
                                        function () {
                                            this._emitNotificationClosed(id, NotificationClosedReason.DISMISSED);
                                        }));
            return invocation.return_value(GLib.Variant.new('(u)', [id]));
        }

        let rewrites = rewriteRules[appName];
        if (rewrites) {
            for (let i = 0; i < rewrites.length; i++) {
                let rule = rewrites[i];
                if (summary.search(rule.pattern) != -1)
                    summary = summary.replace(rule.pattern, rule.replacement);
            }
        }

        // Be compatible with the various hints for image data and image path
        // 'image-data' and 'image-path' are the latest name of these hints, introduced in 1.2

        if (!hints['image-path'] && hints['image_path'])
            hints['image-path'] = hints['image_path']; // version 1.1 of the spec

        if (!hints['image-data'])
            if (hints['image_data'])
                hints['image-data'] = hints['image_data']; // version 1.1 of the spec
            else if (hints['icon_data'] && !hints['image-path'])
                // early versions of the spec; 'icon_data' should only be used if 'image-path' is not available
                hints['image-data'] = hints['icon_data'];

        let ndata = { appName: appName,
                      icon: icon,
                      summary: summary,
                      body: body,
                      actions: actions,
                      hints: hints,
                      timeout: timeout };
        if (replacesId != 0 && this._notifications[replacesId]) {
            ndata.id = id = replacesId;
            ndata.notification = this._notifications[replacesId].notification;
        } else {
            replacesId = 0;
            ndata.id = id = nextNotificationId++;
        }
        this._notifications[id] = ndata;

        let sender = invocation.get_sender();
        let pid = this._senderToPid[sender];

        let source = this._getSource(appName, pid, ndata, sender, null);

        if (source) {
            this._notifyForSource(source, ndata);
            return invocation.return_value(GLib.Variant.new('(u)', [id]));
        }

        if (replacesId) {
            // There's already a pending call to GetConnectionUnixProcessID,
            // which will see the new notification data when it finishes,
            // so we don't have to do anything.
            return invocation.return_value(GLib.Variant.new('(u)', [id]));;
        }

        this._busProxy.GetConnectionUnixProcessIDRemote(sender, Lang.bind(this, function (result, excp) {
            // The app may have updated or removed the notification
            ndata = this._notifications[id];
            if (!ndata)
                return;

            if (excp) {
                logError(excp, 'Call to GetConnectionUnixProcessID failed');
                return;
            }

            let [pid] = result;
            source = this._getSource(appName, pid, ndata, sender, null);

            // We only store sender-pid entries for persistent sources.
            // Removing the entries once the source is destroyed
            // would result in the entries associated with transient
            // sources removed once the notification is shown anyway.
            // However, keeping these pairs would mean that we would
            // possibly remove an entry associated with a persistent
            // source when a transient source for the same sender is
            // distroyed.
            if (!source.isTransient) {
                this._senderToPid[sender] = pid;
                source.connect('destroy', Lang.bind(this, function() {
                    delete this._senderToPid[sender];
                }));
            }
            this._notifyForSource(source, ndata);
        }));

        return invocation.return_value(GLib.Variant.new('(u)', [id]));
    },

    _notifyForSource: function(source, ndata) {
        let [id, icon, summary, body, actions, hints, notification] =
            [ndata.id, ndata.icon, ndata.summary, ndata.body,
             ndata.actions, ndata.hints, ndata.notification];

        let gicon = this._iconForNotificationData(icon, hints);
        let iconActor = new St.Icon({ gicon: gicon,
                                      icon_type: St.IconType.FULLCOLOR,
                                      icon_size: source.ICON_SIZE });

        if (notification == null) {
            notification = new MessageTray.Notification(source, summary, body,
                                                        { icon: iconActor,
                                                          bannerMarkup: true });
            ndata.notification = notification;
            notification.connect('destroy', Lang.bind(this,
                function(n, reason) {
                    delete this._notifications[ndata.id];
                    let notificationClosedReason;
                    switch (reason) {
                        case MessageTray.NotificationDestroyedReason.EXPIRED:
                            notificationClosedReason = NotificationClosedReason.EXPIRED;
                            break;
                        case MessageTray.NotificationDestroyedReason.DISMISSED:
                            notificationClosedReason = NotificationClosedReason.DISMISSED;
                            break;
                        case MessageTray.NotificationDestroyedReason.SOURCE_CLOSED:
                            notificationClosedReason = NotificationClosedReason.APP_CLOSED;
                            break;
                    }
                    this._emitNotificationClosed(ndata.id, notificationClosedReason);
                }));
            notification.connect('action-invoked', Lang.bind(this,
                function(n, actionId) {
                    this._emitActionInvoked(ndata.id, actionId);
                }));
        } else {
            notification.update(summary, body, { icon: iconActor,
                                                 bannerMarkup: true,
                                                 clear: true });
        }

        // We only display a large image if an icon is also specified.
        if (icon && (hints['image-data'] || hints['image-path'])) {
            let image = null;
            if (hints['image-data']) {
                let [width, height, rowStride, hasAlpha,
                 bitsPerSample, nChannels, data] = hints['image-data'];
                image = St.TextureCache.get_default().load_from_raw(data, hasAlpha,
                                                                    width, height, rowStride, notification.IMAGE_SIZE);
            } else if (hints['image-path']) {
                image = St.TextureCache.get_default().load_uri_async(GLib.filename_to_uri(hints['image-path'], null),
                                                                     notification.IMAGE_SIZE,
                                                                     notification.IMAGE_SIZE);
            }
            notification.setImage(image);
        } else {
            notification.unsetImage();
        }

        if (actions.length) {
            notification.setUseActionIcons(hints['action-icons'] == true);
            for (let i = 0; i < actions.length - 1; i += 2) {
                if (actions[i] == 'default')
                    notification.connect('clicked', Lang.bind(this,
                        function() {
                            this._emitActionInvoked(ndata.id, "default");
                        }));
                else
                    notification.addButton(actions[i], actions[i + 1]);
            }
        }
        switch (hints.urgency) {
            case Urgency.LOW:
                notification.setUrgency(MessageTray.Urgency.LOW);
                break;
            case Urgency.NORMAL:
                notification.setUrgency(MessageTray.Urgency.NORMAL);
                break;
            case Urgency.CRITICAL:
                notification.setUrgency(MessageTray.Urgency.CRITICAL);
                break;
        }
        notification.setResident(hints.resident == true);
        // 'transient' is a reserved keyword in JS, so we have to retrieve the value
        // of the 'transient' hint with hints['transient'] rather than hints.transient
        notification.setTransient(hints['transient'] == true);

        let sourceGIcon = source.useNotificationIcon ? this._iconForNotificationData(icon, hints) : null;
        source.processNotification(notification, sourceGIcon);
    },

    CloseNotification: function(id) {
        let ndata = this._notifications[id];
        if (ndata) {
            if (ndata.notification)
                ndata.notification.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
            delete this._notifications[id];
        }
    },

    GetCapabilities: function() {
        return [
            'actions',
            'action-icons',
            'body',
            // 'body-hyperlinks',
            // 'body-images',
            'body-markup',
            // 'icon-multi',
            'icon-static',
            'persistence',
            // 'sound',
        ];
    },

    GetServerInformation: function() {
        return [
            Config.PACKAGE_NAME,
            'GNOME',
            Config.PACKAGE_VERSION,
            '1.2'
        ];
    },

    _onFocusAppChanged: function() {
        let tracker = Shell.WindowTracker.get_default();
        if (!tracker.focus_app)
            return;

        for (let i = 0; i < this._sources.length; i++) {
            let source = this._sources[i];
            if (source.app == tracker.focus_app) {
                source.destroyNonResidentNotifications();
                return;
            }
        }
    },

    _emitNotificationClosed: function(id, reason) {
        this._dbusImpl.emit_signal('NotificationClosed',
                                   GLib.Variant.new('(uu)', [id, reason]));
    },

    _emitActionInvoked: function(id, action) {
        this._dbusImpl.emit_signal('ActionInvoked',
                                   GLib.Variant.new('(us)', [id, action]));
    },

    _onTrayIconAdded: function(o, icon) {
        let source = this._getSource(icon.title || icon.wm_class || C_("program", "Unknown"), icon.pid, null, null, icon);
    },

    _onTrayIconRemoved: function(o, icon) {
        let source = this._lookupSource(null, icon.pid, true);
        if (source)
            source.destroy();
    }
});

const Source = new Lang.Class({
    Name: 'NotificationDaemonSource',
    Extends: MessageTray.Source,

    _init: function(title, pid, sender, trayIcon) {
        this.parent(title);

        this.initialTitle = title;

        this.pid = pid;
        if (sender)
            this._nameWatcherId = Gio.DBus.session.watch_name(sender,
                                                              Gio.BusNameWatcherFlags.NONE,
                                                              null,
                                                              Lang.bind(this, this._onNameVanished));
        else
            this._nameWatcherId = 0;

        this._setApp();
        if (this.app)
            this.title = this.app.get_name();
        else
            this.useNotificationIcon = true;

        this.trayIcon = trayIcon;
        if (this.trayIcon) {
           this._setSummaryIcon(this.trayIcon);
           this.useNotificationIcon = false;
        }
    },

    _onNameVanished: function() {
        // Destroy the notification source when its sender is removed from DBus.
        // Only do so if this.app is set to avoid removing "notify-send" sources, senders
        // of which аre removed from DBus immediately.
        // Sender being removed from DBus would normally result in a tray icon being removed,
        // so allow the code path that handles the tray icon being removed to handle that case.
        if (!this.trayIcon && this.app)
            this.destroy();
    },

    processNotification: function(notification, gicon) {
        if (gicon)
            this._gicon = gicon;
        this._setSummaryIcon(this.createIcon(this.ICON_SIZE));

        let tracker = Shell.WindowTracker.get_default();
        if (notification.resident && this.app && tracker.focus_app == this.app)
            this.pushNotification(notification);
        else
            this.notify(notification);
    },

    handleSummaryClick: function() {
        if (!this.trayIcon)
            return false;

        let event = Clutter.get_current_event();
        if (event.type() != Clutter.EventType.BUTTON_RELEASE)
            return false;

        // Left clicks are passed through only where there aren't unacknowledged
        // notifications, so it possible to open them in summary mode; right
        // clicks are always forwarded, as the right click menu is not useful for
        // tray icons
        if (event.get_button() == 1 &&
            this.notifications.length > 0)
            return false;

        if (Main.overview.visible) {
            // We can't just connect to Main.overview's 'hidden' signal,
            // because it's emitted *before* it calls popModal()...
            let id = global.connect('notify::stage-input-mode', Lang.bind(this,
                function () {
                    global.disconnect(id);
                    this.trayIcon.click(event);
                }));
            Main.overview.hide();
        } else {
            this.trayIcon.click(event);
        }
        return true;
    },

    _getApp: function() {
        let app;

        app = Shell.WindowTracker.get_default().get_app_from_pid(this.pid);
        if (app != null)
            return app;

        if (this.trayIcon) {
            app = Shell.AppSystem.get_default().lookup_wmclass(this.trayIcon.wmclass);
            if (app != null)
                return app;
        }

        return null;
    },

    _setApp: function() {
        if (this.app)
            return;

        this.app = this._getApp();
        if (!this.app)
            return;

        // Only override the icon if we were previously using
        // notification-based icons (ie, not a trayicon) or if it was unset before
        if (!this.trayIcon) {
            this.useNotificationIcon = false;
            this._setSummaryIcon(this.createIcon(this.ICON_SIZE));
        }
    },

    open: function(notification) {
        this.destroyNonResidentNotifications();
        this.openApp();
    },

    _lastNotificationRemoved: function() {
        if (!this.trayIcon)
            this.destroy();
    },

    openApp: function() {
        if (this.app == null)
            return;

        let windows = this.app.get_windows();
        if (windows.length > 0) {
            let mostRecentWindow = windows[0];
            Main.activateWindow(mostRecentWindow);
        }
    },

    destroy: function() {
        if (this._nameWatcherId) {
            Gio.DBus.session.unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }

        this.parent();
    },

    createIcon: function(size) {
        if (this.trayIcon) {
            return new Clutter.Clone({ width: size,
                                       height: size,
                                       source: this.trayIcon });
        } else if (this.app) {
            return this.app.create_icon_texture(size);
        } else if (this._gicon) {
            return new St.Icon({ gicon: this._gicon,
                                 icon_size: size });
        } else {
            return null;
        }
    }
});
