// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;
const Atk = imports.gi.Atk;

const BoxPointer = imports.ui.boxpointer;
const Main = imports.ui.main;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;

const SLIDER_SCROLL_STEP = 0.05; /* Slider scrolling step in % */

function _ensureStyle(actor) {
    if (actor.get_children) {
        let children = actor.get_children();
        for (let i = 0; i < children.length; i++)
            _ensureStyle(children[i]);
    }

    if (actor instanceof St.Widget)
        actor.ensure_style();
}

const PopupBaseMenuItem = new Lang.Class({
    Name: 'PopupBaseMenuItem',

    _init: function (params) {
        params = Params.parse (params, { reactive: true,
                                         activate: true,
                                         hover: true,
                                         sensitive: true,
                                         style_class: null
                                       });
        this.actor = new Shell.GenericContainer({ style_class: 'popup-menu-item',
                                                  reactive: params.reactive,
                                                  track_hover: params.reactive,
                                                  can_focus: params.reactive,
                                                  accessible_role: Atk.Role.MENU_ITEM});
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));
        this.actor.connect('style-changed', Lang.bind(this, this._onStyleChanged));
        this.actor._delegate = this;

        this._children = [];
        this._dot = null;
        this._columnWidths = null;
        this._spacing = 0;
        this.active = false;
        this._activatable = params.reactive && params.activate;
        this.sensitive = this._activatable && params.sensitive;

        this.setSensitive(this.sensitive);

        if (params.style_class)
            this.actor.add_style_class_name(params.style_class);

        if (this._activatable) {
            this.actor.connect('button-release-event', Lang.bind(this, this._onButtonReleaseEvent));
            this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));
        }
        if (params.reactive && params.hover)
            this.actor.connect('notify::hover', Lang.bind(this, this._onHoverChanged));
        if (params.reactive) {
            this.actor.connect('key-focus-in', Lang.bind(this, this._onKeyFocusIn));
            this.actor.connect('key-focus-out', Lang.bind(this, this._onKeyFocusOut));
        }
    },

    _onStyleChanged: function (actor) {
        this._spacing = Math.round(actor.get_theme_node().get_length('spacing'));
    },

    _onButtonReleaseEvent: function (actor, event) {
        this.activate(event);
        return true;
    },

    _onKeyPressEvent: function (actor, event) {
        let symbol = event.get_key_symbol();

        if (symbol == Clutter.KEY_space || symbol == Clutter.KEY_Return) {
            this.activate(event);
            return true;
        }
        return false;
    },

    _onKeyFocusIn: function (actor) {
        this.setActive(true);
    },

    _onKeyFocusOut: function (actor) {
        this.setActive(false);
    },

    _onHoverChanged: function (actor) {
        this.setActive(actor.hover);
    },

    activate: function (event) {
        this.emit('activate', event);
    },

    setActive: function (active, params) {
        let activeChanged = active != this.active;
        params = Params.parse (params, { grabKeyboard: true });

        if (activeChanged) {
            this.active = active;
            if (active) {
                this.actor.add_style_pseudo_class('active');
                if (params.grabKeyboard)
                    this.actor.grab_key_focus();
            } else
                this.actor.remove_style_pseudo_class('active');
            this.emit('active-changed', active);
        }
    },

    setSensitive: function(sensitive) {
        if (!this._activatable)
            return;
        if (this.sensitive == sensitive)
            return;

        this.sensitive = sensitive;
        this.actor.reactive = sensitive;

        this.emit('sensitive-changed', sensitive);
    },

    destroy: function() {
        this.actor.destroy();
        this.emit('destroy');
    },

    // adds an actor to the menu item; @params can contain %span
    // (column span; defaults to 1, -1 means "all the remaining width"),
    // %expand (defaults to #false), and %align (defaults to
    // #St.Align.START)
    addActor: function(child, params) {
        params = Params.parse(params, { span: 1,
                                        expand: false,
                                        align: St.Align.START });
        params.actor = child;
        this._children.push(params);
        this.actor.connect('destroy', Lang.bind(this, function () { this._removeChild(child); }));
        this.actor.add_actor(child);
    },

    _removeChild: function(child) {
        for (let i = 0; i < this._children.length; i++) {
            if (this._children[i].actor == child) {
                this._children.splice(i, 1);
                return;
            }
        }
    },

    removeActor: function(child) {
        this.actor.remove_actor(child);
        this._removeChild(child);
    },

    setShowDot: function(show) {
        if (show) {
            if (this._dot)
                return;

            this._dot = new St.DrawingArea({ style_class: 'popup-menu-item-dot' });
            this._dot.connect('repaint', Lang.bind(this, this._onRepaintDot));
            this.actor.add_actor(this._dot);
        } else {
            if (!this._dot)
                return;

            this._dot.destroy();
            this._dot = null;
        }
    },

    _onRepaintDot: function(area) {
        let cr = area.get_context();
        let [width, height] = area.get_surface_size();
        let color = area.get_theme_node().get_foreground_color();

        cr.setSourceRGBA (
            color.red / 255,
            color.green / 255,
            color.blue / 255,
            color.alpha / 255);
        cr.arc(width / 2, height / 2, width / 3, 0, 2 * Math.PI);
        cr.fill();
    },

    // This returns column widths in logical order (i.e. from the dot
    // to the image), not in visual order (left to right)
    getColumnWidths: function() {
        let widths = [];
        for (let i = 0, col = 0; i < this._children.length; i++) {
            let child = this._children[i];
            let [min, natural] = child.actor.get_preferred_width(-1);
            widths[col++] = natural;
            if (child.span > 1) {
                for (let j = 1; j < child.span; j++)
                    widths[col++] = 0;
            }
        }
        return widths;
    },

    setColumnWidths: function(widths) {
        this._columnWidths = widths;
    },

    _getPreferredWidth: function(actor, forHeight, alloc) {
        let width = 0;
        if (this._columnWidths) {
            for (let i = 0; i < this._columnWidths.length; i++) {
                if (i > 0)
                    width += this._spacing;
                width += this._columnWidths[i];
            }
        } else {
            for (let i = 0; i < this._children.length; i++) {
                let child = this._children[i];
                if (i > 0)
                    width += this._spacing;
                let [min, natural] = child.actor.get_preferred_width(-1);
                width += natural;
            }
        }
        alloc.min_size = alloc.natural_size = width;
    },

    _getPreferredHeight: function(actor, forWidth, alloc) {
        let height = 0, x = 0, minWidth, childWidth;
        for (let i = 0; i < this._children.length; i++) {
            let child = this._children[i];
            if (this._columnWidths) {
                if (child.span == -1) {
                    childWidth = 0;
                    for (let j = i; j < this._columnWidths.length; j++)
                        childWidth += this._columnWidths[j]
                } else
                    childWidth = this._columnWidths[i];
            } else {
                if (child.span == -1)
                    childWidth = forWidth - x;
                else
                    [minWidth, childWidth] = child.actor.get_preferred_width(-1);
            }
            x += childWidth;

            let [min, natural] = child.actor.get_preferred_height(childWidth);
            if (natural > height)
                height = natural;
        }
        alloc.min_size = alloc.natural_size = height;
    },

    _allocate: function(actor, box, flags) {
        let height = box.y2 - box.y1;
        let direction = this.actor.get_text_direction();

        if (this._dot) {
            // The dot is placed outside box
            // one quarter of padding from the border of the container
            // (so 3/4 from the inner border)
            // (padding is box.x1)
            let dotBox = new Clutter.ActorBox();
            let dotWidth = Math.round(box.x1 / 2);

            if (direction == Clutter.TextDirection.LTR) {
                dotBox.x1 = Math.round(box.x1 / 4);
                dotBox.x2 = dotBox.x1 + dotWidth;
            } else {
                dotBox.x2 = box.x2 + 3 * Math.round(box.x1 / 4);
                dotBox.x1 = dotBox.x2 - dotWidth;
            }
            dotBox.y1 = Math.round(box.y1 + (height - dotWidth) / 2);
            dotBox.y2 = dotBox.y1 + dotWidth;
            this._dot.allocate(dotBox, flags);
        }

        let x;
        if (direction == Clutter.TextDirection.LTR)
            x = box.x1;
        else
            x = box.x2;
        // if direction is ltr, x is the right edge of the last added
        // actor, and it's constantly increasing, whereas if rtl, x is
        // the left edge and it decreases
        for (let i = 0, col = 0; i < this._children.length; i++) {
            let child = this._children[i];
            let childBox = new Clutter.ActorBox();

            let [minWidth, naturalWidth] = child.actor.get_preferred_width(-1);
            let availWidth, extraWidth;
            if (this._columnWidths) {
                if (child.span == -1) {
                    if (direction == Clutter.TextDirection.LTR)
                        availWidth = box.x2 - x;
                    else
                        availWidth = x - box.x1;
                } else {
                    availWidth = 0;
                    for (let j = 0; j < child.span; j++)
                        availWidth += this._columnWidths[col++];
                }
                extraWidth = availWidth - naturalWidth;
            } else {
                if (child.span == -1) {
                    if (direction == Clutter.TextDirection.LTR)
                        availWidth = box.x2 - x;
                    else
                        availWidth = x - box.x1;
                } else {
                    availWidth = naturalWidth;
                }
                extraWidth = 0;
            }

            if (direction == Clutter.TextDirection.LTR) {
                if (child.expand) {
                    childBox.x1 = x;
                    childBox.x2 = x + availWidth;
                } else if (child.align === St.Align.MIDDLE) {
                    childBox.x1 = x + Math.round(extraWidth / 2);
                    childBox.x2 = childBox.x1 + naturalWidth;
                } else if (child.align === St.Align.END) {
                    childBox.x2 = x + availWidth;
                    childBox.x1 = childBox.x2 - naturalWidth;
                } else {
                    childBox.x1 = x;
                    childBox.x2 = x + naturalWidth;
                }
            } else {
                if (child.expand) {
                    childBox.x1 = x - availWidth;
                    childBox.x2 = x;
                } else if (child.align === St.Align.MIDDLE) {
                    childBox.x1 = x - Math.round(extraWidth / 2);
                    childBox.x2 = childBox.x1 + naturalWidth;
                } else if (child.align === St.Align.END) {
                    // align to the left
                    childBox.x1 = x - availWidth;
                    childBox.x2 = childBox.x1 + naturalWidth;
                } else {
                    // align to the right
                    childBox.x2 = x;
                    childBox.x1 = x - naturalWidth;
                }
            }

            let [minHeight, naturalHeight] = child.actor.get_preferred_height(childBox.x2 - childBox.x1);
            childBox.y1 = Math.round(box.y1 + (height - naturalHeight) / 2);
            childBox.y2 = childBox.y1 + naturalHeight;

            child.actor.allocate(childBox, flags);

            if (direction == Clutter.TextDirection.LTR)
                x += availWidth + this._spacing;
            else
                x -= availWidth + this._spacing;
        }
    }
});
Signals.addSignalMethods(PopupBaseMenuItem.prototype);

const PopupMenuItem = new Lang.Class({
    Name: 'PopupMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function (text, params) {
        this.parent(params);

        this.label = new St.Label({ text: text });
        this.addActor(this.label);
        this.actor.label_actor = this.label
    }
});

const PopupSeparatorMenuItem = new Lang.Class({
    Name: 'PopupSeparatorMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function () {
        this.parent({ reactive: false });

        this._drawingArea = new St.DrawingArea({ style_class: 'popup-separator-menu-item' });
        this.addActor(this._drawingArea, { span: -1, expand: true });
        this._drawingArea.connect('repaint', Lang.bind(this, this._onRepaint));
    },

    _onRepaint: function(area) {
        let cr = area.get_context();
        let themeNode = area.get_theme_node();
        let [width, height] = area.get_surface_size();
        let margin = themeNode.get_length('-margin-horizontal');
        let gradientHeight = themeNode.get_length('-gradient-height');
        let startColor = themeNode.get_color('-gradient-start');
        let endColor = themeNode.get_color('-gradient-end');

        let gradientWidth = (width - margin * 2);
        let gradientOffset = (height - gradientHeight) / 2;
        let pattern = new Cairo.LinearGradient(margin, gradientOffset, width - margin, gradientOffset + gradientHeight);
        pattern.addColorStopRGBA(0, startColor.red / 255, startColor.green / 255, startColor.blue / 255, startColor.alpha / 255);
        pattern.addColorStopRGBA(0.5, endColor.red / 255, endColor.green / 255, endColor.blue / 255, endColor.alpha / 255);
        pattern.addColorStopRGBA(1, startColor.red / 255, startColor.green / 255, startColor.blue / 255, startColor.alpha / 255);
        cr.setSource(pattern);
        cr.rectangle(margin, gradientOffset, gradientWidth, gradientHeight);
        cr.fill();
    }
});

const PopupAlternatingMenuItemState = {
    DEFAULT: 0,
    ALTERNATIVE: 1
}

const PopupAlternatingMenuItem = new Lang.Class({
    Name: 'PopupAlternatingMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function(text, alternateText, params) {
        this.parent(params);
        this.actor.add_style_class_name('popup-alternating-menu-item');

        this._text = text;
        this._alternateText = alternateText;
        this.label = new St.Label({ text: text });
        this.state = PopupAlternatingMenuItemState.DEFAULT;
        this.addActor(this.label);
        this.actor.label_actor = this.label;

        this.actor.connect('notify::mapped', Lang.bind(this, this._onMapped));
    },

    _onMapped: function() {
        if (this.actor.mapped) {
            this._capturedEventId = global.stage.connect('captured-event',
                                                         Lang.bind(this, this._onCapturedEvent));
            this._updateStateFromModifiers();
        } else {
            if (this._capturedEventId != 0) {
                global.stage.disconnect(this._capturedEventId);
                this._capturedEventId = 0;
            }
        }
    },

    _setState: function(state) {
        if (this.state != state) {
            if (state == PopupAlternatingMenuItemState.ALTERNATIVE && !this._canAlternate())
                return;

            this.state = state;
            this._updateLabel();
        }
    },

    _updateStateFromModifiers: function() {
        let [x, y, mods] = global.get_pointer();
        let state;

        if ((mods & Clutter.ModifierType.MOD1_MASK) == 0) {
            state = PopupAlternatingMenuItemState.DEFAULT;
        } else {
            state = PopupAlternatingMenuItemState.ALTERNATIVE;
        }

        this._setState(state);
    },

    _onCapturedEvent: function(actor, event) {
        if (event.type() != Clutter.EventType.KEY_PRESS &&
            event.type() != Clutter.EventType.KEY_RELEASE)
            return false;

        let key = event.get_key_symbol();

        if (key == Clutter.KEY_Alt_L || key == Clutter.KEY_Alt_R)
            this._updateStateFromModifiers();

        return false;
    },

    _updateLabel: function() {
        if (this.state == PopupAlternatingMenuItemState.ALTERNATIVE) {
            this.actor.add_style_pseudo_class('alternate');
            this.label.set_text(this._alternateText);
        } else {
            this.actor.remove_style_pseudo_class('alternate');
            this.label.set_text(this._text);
        }
    },

    _canAlternate: function() {
        if (this.state == PopupAlternatingMenuItemState.DEFAULT && !this._alternateText)
            return false;
        return true;
    },

    updateText: function(text, alternateText) {
        this._text = text;
        this._alternateText = alternateText;

        if (!this._canAlternate())
            this._setState(PopupAlternatingMenuItemState.DEFAULT);

        this._updateLabel();
    }
});

const PopupSliderMenuItem = new Lang.Class({
    Name: 'PopupSliderMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function(value) {
        this.parent({ activate: false });

        this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));

        if (isNaN(value))
            // Avoid spreading NaNs around
            throw TypeError('The slider value must be a number');
        this._value = Math.max(Math.min(value, 1), 0);

        this._slider = new St.DrawingArea({ style_class: 'popup-slider-menu-item', reactive: true });
        this.addActor(this._slider, { span: -1, expand: true });
        this._slider.connect('repaint', Lang.bind(this, this._sliderRepaint));
        this.actor.connect('button-press-event', Lang.bind(this, this._startDragging));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScrollEvent));
        this.actor.connect('notify::mapped', Lang.bind(this, function() {
            if (!this.actor.mapped)
                this._endDragging();
        }));

        this._releaseId = this._motionId = 0;
        this._dragging = false;
    },

    setValue: function(value) {
        if (isNaN(value))
            throw TypeError('The slider value must be a number');

        this._value = Math.max(Math.min(value, 1), 0);
        this._slider.queue_repaint();
    },

    _sliderRepaint: function(area) {
        let cr = area.get_context();
        let themeNode = area.get_theme_node();
        let [width, height] = area.get_surface_size();

        let handleRadius = themeNode.get_length('-slider-handle-radius');

        let sliderWidth = width - 2 * handleRadius;
        let sliderHeight = themeNode.get_length('-slider-height');

        let sliderBorderWidth = themeNode.get_length('-slider-border-width');

        let sliderBorderColor = themeNode.get_color('-slider-border-color');
        let sliderColor = themeNode.get_color('-slider-background-color');

        let sliderActiveBorderColor = themeNode.get_color('-slider-active-border-color');
        let sliderActiveColor = themeNode.get_color('-slider-active-background-color');

        cr.setSourceRGBA (
            sliderActiveColor.red / 255,
            sliderActiveColor.green / 255,
            sliderActiveColor.blue / 255,
            sliderActiveColor.alpha / 255);
        cr.rectangle(handleRadius, (height - sliderHeight) / 2, sliderWidth * this._value, sliderHeight);
        cr.fillPreserve();
        cr.setSourceRGBA (
            sliderActiveBorderColor.red / 255,
            sliderActiveBorderColor.green / 255,
            sliderActiveBorderColor.blue / 255,
            sliderActiveBorderColor.alpha / 255);
        cr.setLineWidth(sliderBorderWidth);
        cr.stroke();

        cr.setSourceRGBA (
            sliderColor.red / 255,
            sliderColor.green / 255,
            sliderColor.blue / 255,
            sliderColor.alpha / 255);
        cr.rectangle(handleRadius + sliderWidth * this._value, (height - sliderHeight) / 2, sliderWidth * (1 - this._value), sliderHeight);
        cr.fillPreserve();
        cr.setSourceRGBA (
            sliderBorderColor.red / 255,
            sliderBorderColor.green / 255,
            sliderBorderColor.blue / 255,
            sliderBorderColor.alpha / 255);
        cr.setLineWidth(sliderBorderWidth);
        cr.stroke();

        let handleY = height / 2;
        let handleX = handleRadius + (width - 2 * handleRadius) * this._value;

        let color = themeNode.get_foreground_color();
        cr.setSourceRGBA (
            color.red / 255,
            color.green / 255,
            color.blue / 255,
            color.alpha / 255);
        cr.arc(handleX, handleY, handleRadius, 0, 2 * Math.PI);
        cr.fill();
    },

    _startDragging: function(actor, event) {
        if (this._dragging) // don't allow two drags at the same time
            return;

        this._dragging = true;

        // FIXME: we should only grab the specific device that originated
        // the event, but for some weird reason events are still delivered
        // outside the slider if using clutter_grab_pointer_for_device
        Clutter.grab_pointer(this._slider);
        this._releaseId = this._slider.connect('button-release-event', Lang.bind(this, this._endDragging));
        this._motionId = this._slider.connect('motion-event', Lang.bind(this, this._motionEvent));
        let absX, absY;
        [absX, absY] = event.get_coords();
        this._moveHandle(absX, absY);
    },

    _endDragging: function() {
        if (this._dragging) {
            this._slider.disconnect(this._releaseId);
            this._slider.disconnect(this._motionId);

            Clutter.ungrab_pointer();
            this._dragging = false;

            this.emit('drag-end');
        }
        return true;
    },

    _onScrollEvent: function (actor, event) {
        let direction = event.get_scroll_direction();

        if (direction == Clutter.ScrollDirection.DOWN) {
            this._value = Math.max(0, this._value - SLIDER_SCROLL_STEP);
        }
        else if (direction == Clutter.ScrollDirection.UP) {
            this._value = Math.min(1, this._value + SLIDER_SCROLL_STEP);
        }

        this._slider.queue_repaint();
        this.emit('value-changed', this._value);
    },

    _motionEvent: function(actor, event) {
        let absX, absY;
        [absX, absY] = event.get_coords();
        this._moveHandle(absX, absY);
        return true;
    },

    _moveHandle: function(absX, absY) {
        let relX, relY, sliderX, sliderY;
        [sliderX, sliderY] = this._slider.get_transformed_position();
        relX = absX - sliderX;
        relY = absY - sliderY;

        let width = this._slider.width;
        let handleRadius = this._slider.get_theme_node().get_length('-slider-handle-radius');

        let newvalue;
        if (relX < handleRadius)
            newvalue = 0;
        else if (relX > width - handleRadius)
            newvalue = 1;
        else
            newvalue = (relX - handleRadius) / (width - 2 * handleRadius);
        this._value = newvalue;
        this._slider.queue_repaint();
        this.emit('value-changed', this._value);
    },

    get value() {
        return this._value;
    },

    _onKeyPressEvent: function (actor, event) {
        let key = event.get_key_symbol();
        if (key == Clutter.KEY_Right || key == Clutter.KEY_Left) {
            let delta = key == Clutter.KEY_Right ? 0.1 : -0.1;
            this._value = Math.max(0, Math.min(this._value + delta, 1));
            this._slider.queue_repaint();
            this.emit('value-changed', this._value);
            this.emit('drag-end');
            return true;
        }
        return false;
    }
});

const Switch = new Lang.Class({
    Name: 'Switch',

    _init: function(state) {
        this.actor = new St.Bin({ style_class: 'toggle-switch',
                                  accessible_role: Atk.Role.CHECK_BOX});
        // Translators: this MUST be either "toggle-switch-us"
        // (for toggle switches containing the English words
        // "ON" and "OFF") or "toggle-switch-intl" (for toggle
        // switches containing "◯" and "|"). Other values will
        // simply result in invisible toggle switches.
        this.actor.add_style_class_name(_("toggle-switch-us"));
        this.setToggleState(state);
    },

    setToggleState: function(state) {
        if (state)
            this.actor.add_style_pseudo_class('checked');
        else
            this.actor.remove_style_pseudo_class('checked');
        this.state = state;
    },

    toggle: function() {
        this.setToggleState(!this.state);
    }
});

const PopupSwitchMenuItem = new Lang.Class({
    Name: 'PopupSwitchMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function(text, active, params) {
        this.parent(params);

        this.label = new St.Label({ text: text });
        this._switch = new Switch(active);

        this.actor.accessible_role = Atk.Role.CHECK_MENU_ITEM;
        this.checkAccessibleState();
        this.actor.label_actor = this.label;

        this.addActor(this.label);

        this._statusBin = new St.Bin({ x_align: St.Align.END });
        this.addActor(this._statusBin,
                      { expand: true, span: -1, align: St.Align.END });

        this._statusLabel = new St.Label({ text: '',
                                           style_class: 'popup-inactive-menu-item'
                                         });
        this._statusBin.child = this._switch.actor;
    },

    setStatus: function(text) {
        if (text != null) {
            this._statusLabel.text = text;
            this._statusBin.child = this._statusLabel;
            this.actor.reactive = false;
            this.actor.accessible_role = Atk.Role.MENU_ITEM;
        } else {
            this._statusBin.child = this._switch.actor;
            this.actor.reactive = true;
            this.actor.accessible_role = Atk.Role.CHECK_MENU_ITEM;
        }
        this.checkAccessibleState();
    },

    activate: function(event) {
        if (this._switch.actor.mapped) {
            this.toggle();
        }

        // we allow pressing space to toggle the switch
        // without closing the menu
        if (event.type() == Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() == Clutter.KEY_space)
            return;

        this.parent(event);
    },

    toggle: function() {
        this._switch.toggle();
        this.emit('toggled', this._switch.state);
        this.checkAccessibleState();
    },

    get state() {
        return this._switch.state;
    },

    setToggleState: function(state) {
        this._switch.setToggleState(state);
        this.checkAccessibleState();
    },

    checkAccessibleState: function() {
        switch (this.actor.accessible_role) {
        case Atk.Role.CHECK_MENU_ITEM:
            if (this._switch.state)
                this.actor.add_accessible_state (Atk.StateType.CHECKED);
            else
                this.actor.remove_accessible_state (Atk.StateType.CHECKED);
            break;
        default:
            this.actor.remove_accessible_state (Atk.StateType.CHECKED);
        }
    }
});

const PopupImageMenuItem = new Lang.Class({
    Name: 'PopupImageMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function (text, iconName, params) {
        this.parent(params);

        this.label = new St.Label({ text: text });
        this.addActor(this.label);
        this._icon = new St.Icon({ style_class: 'popup-menu-icon' });
        this.addActor(this._icon, { align: St.Align.END });

        this.setIcon(iconName);
    },

    setIcon: function(name) {
        this._icon.icon_name = name;
    }
});

const PopupMenuBase = new Lang.Class({
    Name: 'PopupMenuBase',
    Abstract: true,

    _init: function(sourceActor, styleClass) {
        this.sourceActor = sourceActor;

        if (styleClass !== undefined) {
            this.box = new St.BoxLayout({ style_class: styleClass,
                                          vertical: true });
        } else {
            this.box = new St.BoxLayout({ vertical: true });
        }
        this.box.connect_after('queue-relayout', Lang.bind(this, this._menuQueueRelayout));
        this.length = 0;

        this.isOpen = false;

        // If set, we don't send events (including crossing events) to the source actor
        // for the menu which causes its prelight state to freeze
        this.blockSourceEvents = false;

        // Can be set while a menu is up to let all events through without special
        // menu handling useful for scrollbars in menus, and probably not otherwise.
        this.passEvents = false;

        this._activeMenuItem = null;
        this._childMenus = [];
        this._settingsActions = { };
    },

    addAction: function(title, callback) {
        let menuItem = new PopupMenuItem(title);
        this.addMenuItem(menuItem);
        menuItem.connect('activate', Lang.bind(this, function (menuItem, event) {
            callback(event);
        }));

        return menuItem;
    },

    addSettingsAction: function(title, desktopFile) {
        if (!Main.sessionMode.allowSettings)
            return null;

        let menuItem = this.addAction(title, function() {
                           let app = Shell.AppSystem.get_default().lookup_setting(desktopFile);

                           if (!app) {
                               log('Settings panel for desktop file ' + desktopFile + ' could not be loaded!');
                               return;
                           }

                           Main.overview.hide();
                           app.activate();
                       });

        this._settingsActions[desktopFile] = menuItem;

        return menuItem;
    },

    setSettingsVisibility: function(visible) {
        for (let id in this._settingsActions) {
            let item = this._settingsActions[id];
            item.actor.visible = visible;
        }
    },

    isEmpty: function() {
        return this.box.get_n_children() == 0;
    },

    isChildMenu: function(menu) {
        return this._childMenus.indexOf(menu) != -1;
    },

    addChildMenu: function(menu) {
        if (this.isChildMenu(menu))
            return;

        this._childMenus.push(menu);
        this.emit('child-menu-added', menu);
    },

    removeChildMenu: function(menu) {
        let index = this._childMenus.indexOf(menu);

        if (index == -1)
            return;

        this._childMenus.splice(index, 1);
        this.emit('child-menu-removed', menu);
    },

    /**
     * _connectSubMenuSignals:
     * @object: a menu item, or a menu section
     * @menu: a sub menu, or a menu section
     *
     * Connects to signals on @menu that are necessary for
     * operating the submenu, and stores the ids on @object.
     */
    _connectSubMenuSignals: function(object, menu) {
        object._subMenuActivateId = menu.connect('activate', Lang.bind(this, function() {
            this.emit('activate');
            this.close(BoxPointer.PopupAnimation.FULL);
        }));
        object._subMenuActiveChangeId = menu.connect('active-changed', Lang.bind(this, function(submenu, submenuItem) {
            if (this._activeMenuItem && this._activeMenuItem != submenuItem)
                this._activeMenuItem.setActive(false);
            this._activeMenuItem = submenuItem;
            this.emit('active-changed', submenuItem);
        }));
    },

    _connectItemSignals: function(menuItem) {
        menuItem._activeChangeId = menuItem.connect('active-changed', Lang.bind(this, function (menuItem, active) {
            if (active && this._activeMenuItem != menuItem) {
                if (this._activeMenuItem)
                    this._activeMenuItem.setActive(false);
                this._activeMenuItem = menuItem;
                this.emit('active-changed', menuItem);
            } else if (!active && this._activeMenuItem == menuItem) {
                this._activeMenuItem = null;
                this.emit('active-changed', null);
            }
        }));
        menuItem._sensitiveChangeId = menuItem.connect('sensitive-changed', Lang.bind(this, function(menuItem, sensitive) {
            if (!sensitive && this._activeMenuItem == menuItem) {
                if (!this.actor.navigate_focus(menuItem.actor,
                                               Gtk.DirectionType.TAB_FORWARD,
                                               true))
                    this.actor.grab_key_focus();
            } else if (sensitive && this._activeMenuItem == null) {
                if (global.stage.get_key_focus() == this.actor)
                    menuItem.actor.grab_key_focus();
            }
        }));
        menuItem._activateId = menuItem.connect('activate', Lang.bind(this, function (menuItem, event) {
            this.emit('activate', menuItem);
            this.close(BoxPointer.PopupAnimation.FULL);
        }));
        // the weird name is to avoid a conflict with some random property
        // the menuItem may have, called destroyId
        // (FIXME: in the future it may make sense to have container objects
        // like PopupMenuManager does)
        menuItem._popupMenuDestroyId = menuItem.connect('destroy', Lang.bind(this, function(menuItem) {
            menuItem.disconnect(menuItem._popupMenuDestroyId);
            menuItem.disconnect(menuItem._activateId);
            menuItem.disconnect(menuItem._activeChangeId);
            menuItem.disconnect(menuItem._sensitiveChangeId);
            if (menuItem.menu) {
                menuItem.menu.disconnect(menuItem._subMenuActivateId);
                menuItem.menu.disconnect(menuItem._subMenuActiveChangeId);
                this.disconnect(menuItem._closingId);
            }
            if (menuItem == this._activeMenuItem)
                this._activeMenuItem = null;
        }));
    },

    _updateSeparatorVisibility: function(menuItem) {
        let children = this.box.get_children();

        let index = children.indexOf(menuItem.actor);

        if (index < 0)
            return;

        let childBeforeIndex = index - 1;

        while (childBeforeIndex >= 0 && !children[childBeforeIndex].visible)
            childBeforeIndex--;

        if (childBeforeIndex < 0
            || children[childBeforeIndex]._delegate instanceof PopupSeparatorMenuItem) {
            menuItem.actor.hide();
            return;
        }

        let childAfterIndex = index + 1;

        while (childAfterIndex < children.length && !children[childAfterIndex].visible)
            childAfterIndex++;

        if (childAfterIndex >= children.length
            || children[childAfterIndex]._delegate instanceof PopupSeparatorMenuItem) {
            menuItem.actor.hide();
            return;
        }

        menuItem.actor.show();
    },

    addMenuItem: function(menuItem, position) {
        let before_item = null;
        if (position == undefined) {
            this.box.add(menuItem.actor);
        } else {
            let items = this._getMenuItems();
            if (position < items.length) {
                before_item = items[position].actor;
                this.box.insert_child_below(menuItem.actor, before_item);
            } else {
                this.box.add(menuItem.actor);
            }
        }

        if (menuItem instanceof PopupMenuSection) {
            this._connectSubMenuSignals(menuItem, menuItem);
            menuItem._closingId = this.connect('open-state-changed',
                function(self, open) {
                    if (!open)
                        menuItem.close(BoxPointer.PopupAnimation.FADE);
                });
            menuItem.connect('destroy', Lang.bind(this, function() {
                menuItem.disconnect(menuItem._subMenuActivateId);
                menuItem.disconnect(menuItem._subMenuActiveChangeId);

                this.length--;
            }));
        } else if (menuItem instanceof PopupSubMenuMenuItem) {
            if (before_item == null)
                this.box.add(menuItem.menu.actor);
            else
                this.box.insert_child_below(menuItem.menu.actor, before_item);
            this._connectSubMenuSignals(menuItem, menuItem.menu);
            this._connectItemSignals(menuItem);
            menuItem._closingId = this.connect('open-state-changed', function(self, open) {
                if (!open)
                    menuItem.menu.close(BoxPointer.PopupAnimation.FADE);
            });
        } else if (menuItem instanceof PopupSeparatorMenuItem) {
            this._connectItemSignals(menuItem);

            // updateSeparatorVisibility needs to get called any time the
            // separator's adjacent siblings change visibility or position.
            // open-state-changed isn't exactly that, but doing it in more
            // precise ways would require a lot more bookkeeping.
            this.connect('open-state-changed', Lang.bind(this, function() { this._updateSeparatorVisibility(menuItem); }));
        } else if (menuItem instanceof PopupBaseMenuItem)
            this._connectItemSignals(menuItem);
        else
            throw TypeError("Invalid argument to PopupMenuBase.addMenuItem()");

        this.length++;
    },

    getColumnWidths: function() {
        let columnWidths = [];
        let items = this.box.get_children();
        for (let i = 0; i < items.length; i++) {
            if (!items[i].visible)
                continue;
            if (items[i]._delegate instanceof PopupBaseMenuItem || items[i]._delegate instanceof PopupMenuBase) {
                let itemColumnWidths = items[i]._delegate.getColumnWidths();
                for (let j = 0; j < itemColumnWidths.length; j++) {
                    if (j >= columnWidths.length || itemColumnWidths[j] > columnWidths[j])
                        columnWidths[j] = itemColumnWidths[j];
                }
            }
        }
        return columnWidths;
    },

    setColumnWidths: function(widths) {
        let items = this.box.get_children();
        for (let i = 0; i < items.length; i++) {
            if (items[i]._delegate instanceof PopupBaseMenuItem || items[i]._delegate instanceof PopupMenuBase)
                items[i]._delegate.setColumnWidths(widths);
        }
    },

    // Because of the above column-width funniness, we need to do a
    // queue-relayout on every item whenever the menu itself changes
    // size, to force clutter to drop its cached size requests. (The
    // menuitems will in turn call queue_relayout on their parent, the
    // menu, but that call will be a no-op since the menu already
    // has a relayout queued, so we won't get stuck in a loop.
    _menuQueueRelayout: function() {
        this.box.get_children().map(function (actor) { actor.queue_relayout(); });
    },

    addActor: function(actor) {
        this.box.add(actor);
    },

    _getMenuItems: function() {
        return this.box.get_children().map(function (actor) {
            return actor._delegate;
        }).filter(function(item) {
            return item instanceof PopupBaseMenuItem || item instanceof PopupMenuSection;
        });
    },

    get firstMenuItem() {
        let items = this._getMenuItems();
        if (items.length)
            return items[0];
        else
            return null;
    },

    get numMenuItems() {
        return this._getMenuItems().length;
    },

    removeAll: function() {
        let children = this._getMenuItems();
        for (let i = 0; i < children.length; i++) {
            let item = children[i];
            item.destroy();
        }
    },

    toggle: function() {
        if (this.isOpen)
            this.close(BoxPointer.PopupAnimation.FULL);
        else
            this.open(BoxPointer.PopupAnimation.FULL);
    },

    destroy: function() {
        this.removeAll();
        this.actor.destroy();

        this.emit('destroy');
    }
});
Signals.addSignalMethods(PopupMenuBase.prototype);

const PopupMenu = new Lang.Class({
    Name: 'PopupMenu',
    Extends: PopupMenuBase,

    _init: function(sourceActor, arrowAlignment, arrowSide) {
        this.parent(sourceActor, 'popup-menu-content');

        this._arrowAlignment = arrowAlignment;
        this._arrowSide = arrowSide;

        this._boxPointer = new BoxPointer.BoxPointer(arrowSide,
                                                     { x_fill: true,
                                                       y_fill: true,
                                                       x_align: St.Align.START });
        this.actor = this._boxPointer.actor;
        this.actor._delegate = this;
        this.actor.style_class = 'popup-menu-boxpointer';
        this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));

        this._boxWrapper = new Shell.GenericContainer();
        this._boxWrapper.connect('get-preferred-width', Lang.bind(this, this._boxGetPreferredWidth));
        this._boxWrapper.connect('get-preferred-height', Lang.bind(this, this._boxGetPreferredHeight));
        this._boxWrapper.connect('allocate', Lang.bind(this, this._boxAllocate));
        this._boxPointer.bin.set_child(this._boxWrapper);
        this._boxWrapper.add_actor(this.box);
        this.actor.add_style_class_name('popup-menu');

        global.focus_manager.add_group(this.actor);
        this.actor.reactive = true;
    },

    _boxGetPreferredWidth: function (actor, forHeight, alloc) {
        let columnWidths = this.getColumnWidths();
        this.setColumnWidths(columnWidths);

        // Now they will request the right sizes
        [alloc.min_size, alloc.natural_size] = this.box.get_preferred_width(forHeight);
    },

    _boxGetPreferredHeight: function (actor, forWidth, alloc) {
        [alloc.min_size, alloc.natural_size] = this.box.get_preferred_height(forWidth);
    },

    _boxAllocate: function (actor, box, flags) {
        this.box.allocate(box, flags);
    },

    _onKeyPressEvent: function(actor, event) {
        if (event.get_key_symbol() == Clutter.Escape) {
            this.close(BoxPointer.PopupAnimation.FULL);
            return true;
        }

        return false;
    },

    setArrowOrigin: function(origin) {
        this._boxPointer.setArrowOrigin(origin);
    },

    setSourceAlignment: function(alignment) {
        this._boxPointer.setSourceAlignment(alignment);
    },

    open: function(animate) {
        if (this.isOpen)
            return;

        if (this.isEmpty())
            return;

        this.isOpen = true;

        this._boxPointer.setPosition(this.sourceActor, this._arrowAlignment);
        this._boxPointer.show(animate);

        this.actor.raise_top();

        this.emit('open-state-changed', true);
    },

    close: function(animate) {
        if (!this.isOpen)
            return;

        if (this._activeMenuItem)
            this._activeMenuItem.setActive(false);

        this._boxPointer.hide(animate);

        this.isOpen = false;
        this.emit('open-state-changed', false);
    }
});

const PopupSubMenu = new Lang.Class({
    Name: 'PopupSubMenu',
    Extends: PopupMenuBase,

    _init: function(sourceActor, sourceArrow) {
        this.parent(sourceActor);

        this._arrow = sourceArrow;
        this._arrow.rotation_center_z_gravity = Clutter.Gravity.CENTER;

        // Since a function of a submenu might be to provide a "More.." expander
        // with long content, we make it scrollable - the scrollbar will only take
        // effect if a CSS max-height is set on the top menu.
        this.actor = new St.ScrollView({ style_class: 'popup-sub-menu',
                                         hscrollbar_policy: Gtk.PolicyType.NEVER,
                                         vscrollbar_policy: Gtk.PolicyType.NEVER });

        // StScrollbar plays dirty tricks with events, calling
        // clutter_set_motion_events_enabled (FALSE) during the scroll; this
        // confuses our event tracking, so we just turn it off during the
        // scroll.
        let vscroll = this.actor.get_vscroll_bar();
        vscroll.connect('scroll-start',
                        Lang.bind(this, function() {
                                      let topMenu = this._getTopMenu();
                                      if (topMenu)
                                          topMenu.passEvents = true;
                                  }));
        vscroll.connect('scroll-stop',
                        Lang.bind(this, function() {
                                      let topMenu = this._getTopMenu();
                                      if (topMenu)
                                          topMenu.passEvents = false;
                                  }));

        this.actor.add_actor(this.box);
        this.actor._delegate = this;
        this.actor.clip_to_allocation = true;
        this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));
        this.actor.hide();
    },

    _getTopMenu: function() {
        let actor = this.actor.get_parent();
        while (actor) {
            if (actor._delegate && actor._delegate instanceof PopupMenu)
                return actor._delegate;

            actor = actor.get_parent();
        }

        return null;
    },

    _needsScrollbar: function() {
        let topMenu = this._getTopMenu();
        let [topMinHeight, topNaturalHeight] = topMenu.actor.get_preferred_height(-1);
        let topThemeNode = topMenu.actor.get_theme_node();

        let topMaxHeight = topThemeNode.get_max_height();
        return topMaxHeight >= 0 && topNaturalHeight >= topMaxHeight;
    },

    open: function(animate) {
        if (this.isOpen)
            return;

        if (this.isEmpty())
            return;

        this.isOpen = true;

        this.actor.show();

        let needsScrollbar = this._needsScrollbar();

        // St.ScrollView always requests space horizontally for a possible vertical
        // scrollbar if in AUTOMATIC mode. Doing better would require implementation
        // of width-for-height in St.BoxLayout and St.ScrollView. This looks bad
        // when we *don't* need it, so turn off the scrollbar when that's true.
        // Dynamic changes in whether we need it aren't handled properly.
        this.actor.vscrollbar_policy =
            needsScrollbar ? Gtk.PolicyType.AUTOMATIC : Gtk.PolicyType.NEVER;

        // It looks funny if we animate with a scrollbar (at what point is
        // the scrollbar added?) so just skip that case
        if (animate && needsScrollbar)
            animate = false;

        if (animate) {
            let [minHeight, naturalHeight] = this.actor.get_preferred_height(-1);
            this.actor.height = 0;
            this.actor._arrow_rotation = this._arrow.rotation_angle_z;
            Tweener.addTween(this.actor,
                             { _arrow_rotation: 90,
                               height: naturalHeight,
                               time: 0.25,
                               onUpdateScope: this,
                               onUpdate: function() {
                                   this._arrow.rotation_angle_z = this.actor._arrow_rotation;
                               },
                               onCompleteScope: this,
                               onComplete: function() {
                                   this.actor.set_height(-1);
                                   this.emit('open-state-changed', true);
                               }
                             });
        } else {
            this._arrow.rotation_angle_z = 90;
            this.emit('open-state-changed', true);
        }
    },

    close: function(animate) {
        if (!this.isOpen)
            return;

        this.isOpen = false;

        if (this._activeMenuItem)
            this._activeMenuItem.setActive(false);

        if (animate && this._needsScrollbar())
            animate = false;

        if (animate) {
            this.actor._arrow_rotation = this._arrow.rotation_angle_z;
            Tweener.addTween(this.actor,
                             { _arrow_rotation: 0,
                               height: 0,
                               time: 0.25,
                               onCompleteScope: this,
                               onComplete: function() {
                                   this.actor.hide();
                                   this.actor.set_height(-1);

                                   this.emit('open-state-changed', false);
                               },
                               onUpdateScope: this,
                               onUpdate: function() {
                                   this._arrow.rotation_angle_z = this.actor._arrow_rotation;
                               }
                             });
            } else {
                this._arrow.rotation_angle_z = 0;
                this.actor.hide();

                this.isOpen = false;
                this.emit('open-state-changed', false);
            }
    },

    _onKeyPressEvent: function(actor, event) {
        // Move focus back to parent menu if the user types Left.

        if (this.isOpen && event.get_key_symbol() == Clutter.KEY_Left) {
            this.close(BoxPointer.PopupAnimation.FULL);
            this.sourceActor._delegate.setActive(true);
            return true;
        }

        return false;
    }
});

/**
 * PopupMenuSection:
 *
 * A section of a PopupMenu which is handled like a submenu
 * (you can add and remove items, you can destroy it, you
 * can add it to another menu), but is completely transparent
 * to the user
 */
const PopupMenuSection = new Lang.Class({
    Name: 'PopupMenuSection',
    Extends: PopupMenuBase,

    _init: function() {
        this.parent();

        this.actor = this.box;
        this.actor._delegate = this;
        this.isOpen = true;

        // an array of externally managed separators
        this.separators = [];
    },

    // deliberately ignore any attempt to open() or close(), but emit the
    // corresponding signal so children can still pick it up
    open: function(animate) { this.emit('open-state-changed', true); },
    close: function() { this.emit('open-state-changed', false); },

    destroy: function() {
        for (let i = 0; i < this.separators.length; i++)
            this.separators[i].destroy();
        this.separators = [];

        this.parent();
    }
});

const PopupSubMenuMenuItem = new Lang.Class({
    Name: 'PopupSubMenuMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function(text) {
        this.parent();

        this.actor.add_style_class_name('popup-submenu-menu-item');

        this.label = new St.Label({ text: text });
        this.addActor(this.label);
        this.actor.label_actor = this.label;
        this._triangle = new St.Label({ text: '\u25B8' });
        this.addActor(this._triangle, { align: St.Align.END });

        this.menu = new PopupSubMenu(this.actor, this._triangle);
        this.menu.connect('open-state-changed', Lang.bind(this, this._subMenuOpenStateChanged));
    },

    _subMenuOpenStateChanged: function(menu, open) {
        if (open)
            this.actor.add_style_pseudo_class('open');
        else
            this.actor.remove_style_pseudo_class('open');
    },

    destroy: function() {
        this.menu.destroy();

        this.parent();
    },

    _onKeyPressEvent: function(actor, event) {
        let symbol = event.get_key_symbol();

        if (symbol == Clutter.KEY_Right) {
            this.menu.open(BoxPointer.PopupAnimation.FULL);
            this.menu.actor.navigate_focus(null, Gtk.DirectionType.DOWN, false);
            return true;
        } else if (symbol == Clutter.KEY_Left && this.menu.isOpen) {
            this.menu.close();
            return true;
        }

        return this.parent(actor, event);
    },

    activate: function(event) {
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    },

    _onButtonReleaseEvent: function(actor) {
        this.menu.toggle();
    }
});

const PopupComboMenu = new Lang.Class({
    Name: 'PopupComboMenu',
    Extends: PopupMenuBase,

    _init: function(sourceActor) {
        this.parent(sourceActor, 'popup-combo-menu');

        this.actor = this.box;
        this.actor._delegate = this;
        this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));
        this.actor.connect('key-focus-in', Lang.bind(this, this._onKeyFocusIn));
        sourceActor.connect('style-changed',
                            Lang.bind(this, this._onSourceActorStyleChanged));
        this._activeItemPos = -1;
        global.focus_manager.add_group(this.actor);
    },

    _onKeyPressEvent: function(actor, event) {
        if (event.get_key_symbol() == Clutter.Escape) {
            this.close(BoxPointer.PopupAnimation.FULL);
            return true;
        }

        return false;
    },

    _onKeyFocusIn: function(actor) {
        let items = this._getMenuItems();
        let activeItem = items[this._activeItemPos];
        activeItem.actor.grab_key_focus();
    },

    _onSourceActorStyleChanged: function() {
        // PopupComboBoxMenuItem clones the active item's actors
        // to work with arbitrary items in the menu; this means
        // that we need to propagate some style information and
        // enforce style updates even when the menu is closed
        let activeItem = this._getMenuItems()[this._activeItemPos];
        if (this.sourceActor.has_style_pseudo_class('insensitive'))
            activeItem.actor.add_style_pseudo_class('insensitive');
        else
            activeItem.actor.remove_style_pseudo_class('insensitive');

        // To propagate the :active style, we need to make sure that the
        // internal state of the PopupComboMenu is updated as well, but
        // we must not move the keyboard grab
        activeItem.setActive(this.sourceActor.has_style_pseudo_class('active'),
                             { grabKeyboard: false });

        _ensureStyle(this.actor);
    },

    open: function() {
        if (this.isOpen)
            return;

        if (this.isEmpty())
            return;

        this.isOpen = true;

        let [sourceX, sourceY] = this.sourceActor.get_transformed_position();
        let items = this._getMenuItems();
        let activeItem = items[this._activeItemPos];

        this.actor.set_position(sourceX, sourceY - activeItem.actor.y);
        this.actor.width = Math.max(this.actor.width, this.sourceActor.width);
        this.actor.raise_top();

        this.actor.opacity = 0;
        this.actor.show();

        Tweener.addTween(this.actor,
                         { opacity: 255,
                           transition: 'linear',
                           time: BoxPointer.POPUP_ANIMATION_TIME });

        this.emit('open-state-changed', true);
    },

    close: function() {
        if (!this.isOpen)
            return;

        this.isOpen = false;
        Tweener.addTween(this.actor,
                         { opacity: 0,
                           transition: 'linear',
                           time: BoxPointer.POPUP_ANIMATION_TIME,
                           onComplete: Lang.bind(this,
                               function() {
                                   this.actor.hide();
                               })
                         });

        this.emit('open-state-changed', false);
    },

    setActiveItem: function(position) {
        this._activeItemPos = position;
    },

    getActiveItem: function() {
        return this._getMenuItems()[this._activeItemPos];
    },

    setItemVisible: function(position, visible) {
        if (!visible && position == this._activeItemPos) {
            log('Trying to hide the active menu item.');
            return;
        }

        this._getMenuItems()[position].actor.visible = visible;
    },

    getItemVisible: function(position) {
        return this._getMenuItems()[position].actor.visible;
    }
});

const PopupComboBoxMenuItem = new Lang.Class({
    Name: 'PopupComboBoxMenuItem',
    Extends: PopupBaseMenuItem,

    _init: function (params) {
        this.parent(params);

        this.actor.accessible_role = Atk.Role.COMBO_BOX;

        this._itemBox = new Shell.Stack();
        this.addActor(this._itemBox);

        let expander = new St.Label({ text: '\u2304' });
        this.addActor(expander, { align: St.Align.END,
                                  span: -1 });

        this._menu = new PopupComboMenu(this.actor);
        Main.uiGroup.add_actor(this._menu.actor);
        this._menu.actor.hide();

        if (params.style_class)
            this._menu.actor.add_style_class_name(params.style_class);

        this.actor.connect('scroll-event', Lang.bind(this, this._onScrollEvent));

        this._activeItemPos = -1;
        this._items = [];
    },

    _getTopMenu: function() {
        let actor = this.actor.get_parent();
        while (actor) {
            if (actor._delegate &&
                (actor._delegate instanceof PopupMenu ||
                 actor._delegate instanceof PopupComboMenu))
                return actor._delegate;

            actor = actor.get_parent();
        }

        return null;
    },

    _onScrollEvent: function(actor, event) {
        if (this._activeItemPos == -1)
            return;

        let position = this._activeItemPos;
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.DOWN) {
            while (position < this._items.length - 1) {
                position++;
                if (this._menu.getItemVisible(position))
                    break;
            }
        } else if (direction == Clutter.ScrollDirection.UP) {
            while (position > 0) {
                position--;
                if (this._menu.getItemVisible(position))
                    break;
            }
        }

        if (position == this._activeItemPos)
            return;

        this.setActiveItem(position);
        this.emit('active-item-changed', position);
    },

    activate: function(event) {
        let topMenu = this._getTopMenu();
        if (!topMenu)
            return;

        topMenu.addChildMenu(this._menu);
        this._menu.toggle();
    },

    addMenuItem: function(menuItem, position) {
        if (position === undefined)
            position = this._menu.numMenuItems;

        this._menu.addMenuItem(menuItem, position);
        _ensureStyle(this._menu.actor);

        let item = new St.BoxLayout({ style_class: 'popup-combobox-item' });

        let children = menuItem.actor.get_children();
        for (let i = 0; i < children.length; i++) {
            let clone = new Clutter.Clone({ source: children[i] });
            item.add(clone, { y_fill: false });
        }

        let oldItem = this._items[position];
        if (oldItem)
            this._itemBox.remove_actor(oldItem);

        this._items[position] = item;
        this._itemBox.add_actor(item);

        menuItem.connect('activate',
                         Lang.bind(this, this._itemActivated, position));
    },

    checkAccessibleLabel: function() {
        let activeItem = this._menu.getActiveItem();
        this.actor.label_actor = activeItem.label;
    },

    setActiveItem: function(position) {
        let item = this._items[position];
        if (!item)
            return;
        if (this._activeItemPos == position)
            return;
        this._menu.setActiveItem(position);
        this._activeItemPos = position;
        for (let i = 0; i < this._items.length; i++)
            this._items[i].visible = (i == this._activeItemPos);

        this.checkAccessibleLabel();
    },

    setItemVisible: function(position, visible) {
        this._menu.setItemVisible(position, visible);
    },

    _itemActivated: function(menuItem, event, position) {
        this.setActiveItem(position);
        this.emit('active-item-changed', position);
    }
});

/**
 * RemoteMenu:
 *
 * A PopupMenu that tracks a GMenuModel and shows its actions
 * (exposed by GApplication/GActionGroup)
 */
const RemoteMenu = new Lang.Class({
    Name: 'RemoteMenu',
    Extends: PopupMenu,

    _init: function(sourceActor, model, actionGroup) {
        this.parent(sourceActor, 0.0, St.Side.TOP);

        this.model = model;
        this.actionGroup = actionGroup;

        this._actions = { };
        this._modelChanged(this.model, 0, 0, this.model.get_n_items(), this);

        this._actionStateChangeId = this.actionGroup.connect('action-state-changed', Lang.bind(this, this._actionStateChanged));
        this._actionEnableChangeId = this.actionGroup.connect('action-enabled-changed', Lang.bind(this, this._actionEnabledChanged));
    },

    destroy: function() {
        if (this._actionStateChangeId) {
            this.actionGroup.disconnect(this._actionStateChangeId);
            this._actionStateChangeId = 0;
        }

        if (this._actionEnableChangeId) {
            this.actionGroup.disconnect(this._actionEnableChangeId);
            this._actionEnableChangeId = 0;
        }

        this.parent();
    },

    _createMenuItem: function(model, index) {
        let labelValue = model.get_item_attribute_value(index, Gio.MENU_ATTRIBUTE_LABEL, null);
        let label = labelValue ? labelValue.deep_unpack() : '';
        // remove all underscores that are not followed by another underscore
        label = label.replace(/_([^_])/, '$1');

        let section_link = model.get_item_link(index, Gio.MENU_LINK_SECTION);
        if (section_link) {
            let item = new PopupMenuSection();
            if (label) {
                let title = new PopupMenuItem(label, { reactive: false,
                                                       style_class: 'popup-subtitle-menu-item' });
                item._titleMenuItem = title;
                title._ignored = true;
                item.addMenuItem(title);
            }
            this._modelChanged(section_link, 0, 0, section_link.get_n_items(), item);
            return [item, true, ''];
        }

        let submenu_link = model.get_item_link(index, Gio.MENU_LINK_SUBMENU);

        if (submenu_link) {
            let item = new PopupSubMenuMenuItem(label);
            this._modelChanged(submenu_link, 0, 0, submenu_link.get_n_items(), item.menu);
            return [item, false, ''];
        }

        let action_id = model.get_item_attribute_value(index, Gio.MENU_ATTRIBUTE_ACTION, null).deep_unpack();
        if (!this.actionGroup.has_action(action_id)) {
            // the action may not be there yet, wait for action-added
            return [null, false, 'action-added'];
        }

        if (!this._actions[action_id])
            this._actions[action_id] = { enabled: this.actionGroup.get_action_enabled(action_id),
                                         state: this.actionGroup.get_action_state(action_id),
                                         items: [ ],
                                       };
        let action = this._actions[action_id];
        let item, target, destroyId, specificSignalId;

        if (action.state) {
            // Docs have get_state_hint(), except that the DBus protocol
            // has no provision for it (so ShellApp does not implement it,
            // and neither GApplication), and g_action_get_state_hint()
            // always returns null
            // Funny :)

            switch (String.fromCharCode(action.state.classify())) {
            case 'b':
                item = new PopupSwitchMenuItem(label, action.state.get_boolean());
                action.items.push(item);
                specificSignalId = item.connect('toggled', Lang.bind(this, function(item) {
                    this.actionGroup.activate_action(action_id, null);
                }));
                break;
            case 's':
                item = new PopupMenuItem(label);
                item._remoteTarget = model.get_item_attribute_value(index, Gio.MENU_ATTRIBUTE_TARGET, null).deep_unpack();
                action.items.push(item);
                item.setShowDot(action.state.deep_unpack() == item._remoteTarget);
                specificSignalId = item.connect('activate', Lang.bind(this, function(item) {
                    this.actionGroup.activate_action(action_id, GLib.Variant.new_string(item._remoteTarget));
                }));
                break;
            default:
                log('Action "%s" has state of type %s, which is not supported'.format(action_id, action.state.get_type_string()));
                return [null, false, 'action-state-changed'];
            }
        } else {
            target = model.get_item_attribute_value(index, Gio.MENU_ATTRIBUTE_TARGET, null);
            item = new PopupMenuItem(label);
            action.items.push(item);
            specificSignalId = item.connect('activate', Lang.bind(this, function() {
                this.actionGroup.activate_action(action_id, target);
            }));
        }

        item.actor.reactive = action.enabled;

        destroyId = item.connect('destroy', Lang.bind(this, function() {
            item.disconnect(destroyId);
            item.disconnect(specificSignalId);

            let pos = action.items.indexOf(item);
            if (pos != -1)
                action.items.splice(pos, 1);
        }));

        return [item, false, ''];
    }, 

    _modelChanged: function(model, position, removed, added, target) {
        let j, k;
        let j0, k0;

        let currentItems = target._getMenuItems();

        k0 = 0;
        // skip ignored items at the beginning
        while (k0 < currentItems.length && currentItems[k0]._ignored)
            k0++;
        // find the right menu item matching the model item
        for (j0 = 0; k0 < currentItems.length && j0 < position; j0++, k0++) {
            if (currentItems[k0]._ignored)
                k0++;
        }

        if (removed == -1) {
            // special flag to indicate we should destroy everything
            for (k = k0; k < currentItems.length; k++)
                currentItems[k].destroy();
        } else {
            for (j = j0, k = k0; k < currentItems.length && j < j0 + removed; j++, k++) {
                currentItems[k].destroy();

                if (currentItems[k]._ignored)
                    j--;
            }
        }

        for (j = j0, k = k0; j < j0 + added; j++, k++) {
            let [item, addSeparator, changeSignal] = this._createMenuItem(model, j);

            if (item) {
                // separators must be added in the parent to make autohiding work
                if (addSeparator) {
                    let separator = new PopupSeparatorMenuItem();
                    item.separators.push(separator);
                    separator._ignored = true;
                    target.addMenuItem(separator, k+1);
                    k++;
                }

                target.addMenuItem(item, k);

                if (addSeparator) {
                    let separator = new PopupSeparatorMenuItem();
                    item.separators.push(separator);
                    separator._ignored = true;
                    target.addMenuItem(separator, k+1);
                    k++;
                }
            } else if (changeSignal) {
                let signalId = this.actionGroup.connect(changeSignal, Lang.bind(this, function(actionGroup, actionName) {
                    actionGroup.disconnect(signalId);
                    if (this._actions[actionName]) return;

                    // force a full update
                    this._modelChanged(model, 0, -1, model.get_n_items(), target);
                }));
            }
        }

        if (!model._changedId) {
            model._changedId = model.connect('items-changed', Lang.bind(this, this._modelChanged, target));
            model._destroyId = target.connect('destroy', function() {
                if (model._changedId)
                    model.disconnect(model._changedId);
                if (model._destroyId)
                    target.disconnect(model._destroyId);
                model._changedId = 0;
                model._destroyId = 0;
            });
        }

        if (target instanceof PopupMenuSection) {
            if (target._titleMenuItem)
                target.actor.visible = target.numMenuItems != 1;
            else
                target.actor.visible = target.numMenuItems != 0;
        } else {
            let sourceItem = target.sourceActor._delegate;
            if (sourceItem instanceof PopupSubMenuMenuItem)
                sourceItem.actor.visible = target.numMenuItems != 0;
        }
    },

    _actionStateChanged: function(actionGroup, action_id) {
        let action = this._actions[action_id];
        if (!action)
            return;

        action.state = actionGroup.get_action_state(action_id);
        if (action.items.length) {
            switch (String.fromCharCode(action.state.classify())) {
            case 'b':
                for (let i = 0; i < action.items.length; i++)
                    action.items[i].setToggleState(action.state.get_boolean());
                break;
            case 'd':
                for (let i = 0; i < action.items.length; i++)
                    action.items[i].setValue(action.state.get_double());
                break;
            case 's':
                for (let i = 0; i < action.items.length; i++)
                    action.items[i].setShowDot(action.items[i]._remoteTarget == action.state.deep_unpack());
            }
        }
    },

    _actionEnabledChanged: function(actionGroup, action_id) {
        let action = this._actions[action_id];
        if (!action)
            return;

        action.enabled = actionGroup.get_action_enabled(action_id);
        if (action.items.length) {
            for (let i = 0; i < action.items.length; i++) {
                let item = action.items[i];
                item.actor.reactive = action.enabled;
            }
        }
    }
});

/* Basic implementation of a menu manager.
 * Call addMenu to add menus
 */
const PopupMenuManager = new Lang.Class({
    Name: 'PopupMenuManager',

    _init: function(owner) {
        this._owner = owner;
        this.grabbed = false;

        this._eventCaptureId = 0;
        this._enterEventId = 0;
        this._leaveEventId = 0;
        this._keyFocusNotifyId = 0;
        this._activeMenu = null;
        this._menus = [];
        this._menuStack = [];
        this._preGrabInputMode = null;
        this._grabbedFromKeynav = false;
    },

    addMenu: function(menu, position) {
        let menudata = {
            menu:              menu,
            openStateChangeId: menu.connect('open-state-changed', Lang.bind(this, this._onMenuOpenState)),
            childMenuAddedId:  menu.connect('child-menu-added', Lang.bind(this, this._onChildMenuAdded)),
            childMenuRemovedId: menu.connect('child-menu-removed', Lang.bind(this, this._onChildMenuRemoved)),
            destroyId:         menu.connect('destroy', Lang.bind(this, this._onMenuDestroy)),
            enterId:           0,
            focusInId:         0
        };

        let source = menu.sourceActor;
        if (source) {
            menudata.enterId = source.connect('enter-event', Lang.bind(this, function() { this._onMenuSourceEnter(menu); }));
            menudata.focusInId = source.connect('key-focus-in', Lang.bind(this, function() { this._onMenuSourceEnter(menu); }));
        }

        if (position == undefined)
            this._menus.push(menudata);
        else
            this._menus.splice(position, 0, menudata);
    },

    removeMenu: function(menu) {
        if (menu == this._activeMenu)
            this._closeMenu();

        let position = this._findMenu(menu);
        if (position == -1) // not a menu we manage
            return;

        let menudata = this._menus[position];
        menu.disconnect(menudata.openStateChangeId);
        menu.disconnect(menudata.childMenuAddedId);
        menu.disconnect(menudata.childMenuRemovedId);
        menu.disconnect(menudata.destroyId);

        if (menudata.enterId)
            menu.sourceActor.disconnect(menudata.enterId);
        if (menudata.focusInId)
            menu.sourceActor.disconnect(menudata.focusInId);

        this._menus.splice(position, 1);
    },

    _grab: function() {
        Main.pushModal(this._owner.actor);

        this._eventCaptureId = global.stage.connect('captured-event', Lang.bind(this, this._onEventCapture));
        // captured-event doesn't see enter/leave events
        this._enterEventId = global.stage.connect('enter-event', Lang.bind(this, this._onEventCapture));
        this._leaveEventId = global.stage.connect('leave-event', Lang.bind(this, this._onEventCapture));
        this._keyFocusNotifyId = global.stage.connect('notify::key-focus', Lang.bind(this, this._onKeyFocusChanged));

        this.grabbed = true;
    },

    _ungrab: function() {
        global.stage.disconnect(this._eventCaptureId);
        this._eventCaptureId = 0;
        global.stage.disconnect(this._enterEventId);
        this._enterEventId = 0;
        global.stage.disconnect(this._leaveEventId);
        this._leaveEventId = 0;
        global.stage.disconnect(this._keyFocusNotifyId);
        this._keyFocusNotifyId = 0;

        this.grabbed = false;
        Main.popModal(this._owner.actor);
    },

    _onMenuOpenState: function(menu, open) {
        if (open) {
            if (this._activeMenu && this._activeMenu.isChildMenu(menu)) {
                this._menuStack.push(this._activeMenu);
                menu.actor.grab_key_focus();
            }
            this._activeMenu = menu;
        } else {
            if (this._menuStack.length > 0) {
                this._activeMenu = this._menuStack.pop();
                if (menu.sourceActor)
                    menu.sourceActor.grab_key_focus();
                this._didPop = true;
            }
        }

        // Check what the focus was before calling pushModal/popModal
        let focus = global.stage.key_focus;
        let hadFocus = focus && this._activeMenuContains(focus);

        if (open) {
            if (!this.grabbed) {
                this._preGrabInputMode = global.stage_input_mode;
                this._grabbedFromKeynav = hadFocus;
                this._grab();
            }

            if (hadFocus)
                focus.grab_key_focus();
            else
                menu.actor.grab_key_focus();
        } else if (menu == this._activeMenu) {
            if (this.grabbed)
                this._ungrab();
            this._activeMenu = null;

            if (this._grabbedFromKeynav) {
                if (this._preGrabInputMode == Shell.StageInputMode.FOCUSED)
                    global.stage_input_mode = Shell.StageInputMode.FOCUSED;
                if (hadFocus && menu.sourceActor)
                    menu.sourceActor.grab_key_focus();
                else if (focus)
                    focus.grab_key_focus();
            }
        }
    },

    _onChildMenuAdded: function(menu, childMenu) {
        this.addMenu(childMenu);
    },

    _onChildMenuRemoved: function(menu, childMenu) {
        this.removeMenu(childMenu);
    },

    // change the currently-open menu without dropping grab
    _changeMenu: function(newMenu) {
        if (this._activeMenu) {
            // _onOpenMenuState will drop the grab if it sees
            // this._activeMenu being closed; so clear _activeMenu
            // before closing it to keep that from happening
            let oldMenu = this._activeMenu;
            this._activeMenu = null;
            for (let i = this._menuStack.length - 1; i >= 0; i--)
                this._menuStack[i].close(BoxPointer.PopupAnimation.FADE);
            oldMenu.close(BoxPointer.PopupAnimation.FADE);
            newMenu.open(BoxPointer.PopupAnimation.FADE);
        } else
            newMenu.open(BoxPointer.PopupAnimation.FULL);
    },

    _onMenuSourceEnter: function(menu) {
        if (!this.grabbed || menu == this._activeMenu)
            return false;

        if (this._activeMenu && this._activeMenu.isChildMenu(menu))
            return false;

        if (this._menuStack.indexOf(menu) != -1)
            return false;

        if (this._menuStack.length > 0 && this._menuStack[0].isChildMenu(menu))
            return false;

        this._changeMenu(menu);
        return false;
    },

    _onKeyFocusChanged: function() {
        if (!this.grabbed || !this._activeMenu)
            return;

        let focus = global.stage.key_focus;
        if (focus) {
            if (this._activeMenuContains(focus))
                return;
            if (this._menuStack.length > 0)
                return;
            if (focus._delegate && focus._delegate.menu &&
                this._findMenu(focus._delegate.menu) != -1)
                return;
        }

        this._closeMenu();
    },

    _onMenuDestroy: function(menu) {
        this.removeMenu(menu);
    },

    _activeMenuContains: function(actor) {
        return this._activeMenu != null
                && (this._activeMenu.actor.contains(actor) ||
                    (this._activeMenu.sourceActor && this._activeMenu.sourceActor.contains(actor)));
    },

    _eventIsOnActiveMenu: function(event) {
        return this._activeMenuContains(event.get_source());
    },

    _shouldBlockEvent: function(event) {
        let src = event.get_source();

        if (this._activeMenu != null && this._activeMenu.actor.contains(src))
            return false;

        for (let i = 0; i < this._menus.length; i++) {
            let menu = this._menus[i].menu;
            if (menu.sourceActor && !menu.blockSourceEvents && menu.sourceActor.contains(src)) {
                return false;
            }
        }

        return true;
    },

    _findMenu: function(item) {
        for (let i = 0; i < this._menus.length; i++) {
            let menudata = this._menus[i];
            if (item == menudata.menu)
                return i;
        }
        return -1;
    },

    _onEventCapture: function(actor, event) {
        if (!this.grabbed)
            return false;

        if (this._owner.menuEventFilter &&
            this._owner.menuEventFilter(event))
            return true;

        if (this._activeMenu != null && this._activeMenu.passEvents)
            return false;

        if (this._didPop) {
            this._didPop = false;
            return true;
        }

        let activeMenuContains = this._eventIsOnActiveMenu(event);
        let eventType = event.type();

        if (eventType == Clutter.EventType.BUTTON_RELEASE) {
            if (activeMenuContains) {
                return false;
            } else {
                this._closeMenu();
                return true;
            }
        } else if (eventType == Clutter.EventType.BUTTON_PRESS && !activeMenuContains) {
            this._closeMenu();
            return true;
        } else if (!this._shouldBlockEvent(event)) {
            return false;
        }

        return true;
    },

    _closeMenu: function() {
        if (this._activeMenu != null)
            this._activeMenu.close(BoxPointer.PopupAnimation.FULL);
    }
});
