module.exports = Channel;

var _ = require('lodash');
var EventEmitter = require('events').EventEmitter;
var inherits = require('inherits');
var path = require('path');

var access = require('vanadium/src/v.io/v23/services/security/access');
var noop = require('./noop');
var ServiceVdl = require('./chat/vdl');
var util = require('./util');

function Member(blessings, path) {
  this.name = util.firstShortName(blessings);
  this.path = path;
}

function memberNames(members) {
  return _.map(members, function(member) {
    return member.name;
  }).sort();
}

// Joins the specified channel, creating it if needed.
// Emits 'members', 'message', and 'ready' events.
function Channel(rt, channelName, cb) {
  cb = cb || noop;

  this.channelName_ = path.join('apps/chat', channelName);

  this.accountName_ = rt.accountName;
  this.namespace_ = rt.namespace();
  this.context_ = rt.getContext();
  this.client_ = rt.newClient();
  this.server_ = rt.newServer();

  this.ee_ = new EventEmitter();
  this.ready_ = false;
  this.members_ = [];
  this.intervalID_ = null;  // initialized below

  var that = this;

  // Create our service implementation, which defines a single method:
  // "SendMessage".  We inherit from ServiceVdl.Chat which causes our defined
  // VDL types to be used when serializing values on the wire.  This is
  // necessary for the web client to be able to communicate with the shell
  // client.
  var Service = function() {
    ServiceVdl.Chat.call(this);
  };
  inherits(Service, ServiceVdl.Chat);

  Service.prototype.sendMessage = function(ctx, text) {
    that.ee_.emit('message', {
      sender: util.firstShortName(ctx.remoteBlessingStrings),
      text: text,
      timestamp: new Date()
    });
  };

  // TODO(nlacasee,sadovsky): Our current authorization policy never returns any
  // errors, i.e. everyone is authorized!
  var openAuthorizer = function(){ return null; };
  var options = {authorizer: openAuthorizer};

  // Get a locked name to mount under.
  this.getLockedName_(function(err, name) {
    if (err) {
      return cb(err);
    }

    that.mountedName_ = name;

    // Note, serve() performs the mount() for us.
    that.server_.serve(name, new Service(), options, function(err) {
      if (err) return cb(err);
      // Use nextTick() for the first updateMembers_() call to give clients a
      // chance to set up their event listeners.
      process.nextTick(that.updateMembers_.bind(that));
      // TODO(sadovsky): Replace with mounttable glob watch.
      that.intervalID_ = setInterval(that.updateMembers_.bind(that), 2000);
      return cb();
    });
  });
}

Channel.prototype.getLockedName_ = function(cb) {
  // openACL gives everybody permission.
  var openACL = new access.ACL({
    'in': ['...']
  });

  // myACL only gives my blessings and decendants permission.
  var myACL = new access.ACL({
    'in': [this.accountName_]
  });

  // Create a tagged acl map with the desired permissions.
  var tam = new access.TaggedACLMap(new Map([
    // Give everybody the ability to read and resolve the name.
    ['Read', openACL],
    ['Resolve', openACL],
    // All other permissions are only for us.
    ['Admin', myACL],
    ['Create', myACL],
    ['Mount', myACL]
  ]));

  var that = this;

  // Repeatedly pick random names and try to setACL on them until we get one
  // that has not already been locked.
  var maxRetries = 25;
  function attemptToGetName(tries) {
    if (tries >= maxRetries) {
      return cb(new Error('Tried ' + maxRetries + ' to get an unlocked name ' +
            'but did not succeed.'));
    }

    // Choose a random name under the channel name.
    var name = path.join(that.channelName_, util.randomHex(32));
    var ctx = that.context_.withTimeout(5000);
    that.namespace_.setACL(ctx, name, tam, '', function(err) {
      ctx.done();
      if (err) {
        // Try again.
        return attemptToGetName(tries++);
      }
      return cb(null, name);
    });
  }

  attemptToGetName(0);
};

Channel.prototype.leave = function(cb) {
  cb = cb || noop;
  clearInterval(this.intervalID_);

  if (this.mountedName_) {
    this.namespace_.delete(this.context_, this.mountedName_, true, noop);
  }

  this.server_.stop(cb);
};

Channel.prototype.broadcastMessage = function(messageText, cb) {
  var that = this;
  cb = cb || noop;
  // Schedule all messages to be sent, then return immediately.
  // TODO(sadovsky): Better error handling, perhaps?
  _.forEach(this.members_, function(member) {
    process.nextTick(function() {
      var ctx = that.context_.withTimeout(5000);
      // TODO(nlacasse): Make sure that the server we bindTo has the blessings
      // that we got when we globbed.  This will prevent some other member from
      // sneaking in with the same name as a recently-disconnected member and
      // getting messages meant for the first member.
      that.client_.bindTo(ctx, member.path, function(err, s) {
        if (err) {
          console.error(err);
          ctx.done();
        } else {
          s.sendMessage(ctx, messageText, function(err) {
            if (err) console.error(err);
            ctx.done();
          });
        }
      });
    });
  });
  return cb();
};

Channel.prototype.updateMembers_ = function() {
  var that = this;

  // We glob on the channel name to find all the members in our channel.  The
  // glob will return a stream of mount entries corresponding to the paths where
  // channel members are mounted.  Then, we get the remote blessings from each
  // member, and use those as the member names.

  var ctx = this.context_.withTimeout(1000);
  var pattern = path.join(this.channelName_, '*');

  // Start the glob rpc.  This returns a promise with a "stream" property.
  // Mount entries are emitted on the stream.
  var globRpc = this.namespace_.glob(ctx, pattern);
  var globStream = globRpc.stream;
  globRpc.catch(function(err) {
    console.error(err);
  });

  var newMembers = [];
  var doneGlobbing = false;
  var globResults = 0;

  function done(err) {
    if (err) console.error(err);
    doneGlobbing = true;
  }

  globStream.on('end', done);
  globStream.on('error', done);

  // Each time we get a mount entry, we request the remote blessings from the
  // server and use those and the path to create a new Member object.
  globStream.on('data', function(mountEntry) {
    if (!mountEntry.servers) {
      // No servers mounted at that name, only a lonely ACL.  Safe to ignore.
      return;
    }

    globResults++;
    var path = mountEntry.name;

    // Request the remote blessings from the server.  This will make an RPC to
    // the server and return the blessings that the remote server used to
    // authenticate.  These blessings are cryptographically verified and can't
    // be forged by the remote server.
    that.client_.remoteBlessings(ctx, path, function(err, blessings) {
      if (err) {
        // Member has disconnected or is not responding.  Add a null so we can
        // keep track of how many glob results we have resolved.
        newMembers.push(null);
      } else {
        newMembers.push(new Member(blessings, path));
      }

      // If the glob stream is closed and we have constructed a Member object
      // for each glob result, then we are finished.
      if (doneGlobbing && newMembers.length === globResults) {
        // Remove the nulls.
        newMembers = _.filter(newMembers);

        if (newMembers.length === 0) {
          // No glob results, not even us!  Don't emit anything yet.
          return;
        }

        // Get the member names for the old and new members and if they differ
        // emit a "members" event which the UI will use to update the members
        // list.
        var oldMemberNames = memberNames(that.members_);
        that.members_ = newMembers;
        var newMemberNames = memberNames(that.members_);
        if (!_.isEqual(oldMemberNames, newMemberNames)) {
          that.ee_.emit('members', newMemberNames);
        }

        if (!that.ready_) {
          that.ready_ = true;
          that.ee_.emit('ready');
        }
      }
    });
  });
};

Channel.prototype.addEventListener = function(event, listener) {
  this.ee_.addListener(event, listener);
  return this;
};

Channel.prototype.once = function(event, listener) {
  this.ee_.once(event, listener);
  return this;
};

Channel.prototype.on = Channel.prototype.addEventListener;

Channel.prototype.removeEventListener = function(event, listener) {
  this.ee_.removeListener(event, listener);
  return this;
};

Channel.prototype.off = Channel.prototype.removeEventListener;
