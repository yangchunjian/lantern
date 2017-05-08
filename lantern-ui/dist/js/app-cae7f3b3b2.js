'use strict';

angular.module('feeds-services', []).factory('feedService', ['$q', '$http', function ($q, $http, $sce) {

  var getFeeds = function (feedURL, fallbackURL, gaMgr) {
    var deferred = $q.defer();

    var handleResponse = function (response) {
      var data = response.data;
      if (!data.entries) {
        deferred.reject(new Error("invalid data format"));
        return;
      }
      deferred.resolve(data);
    };

    var handleError = function(response) {
      if (response.status) {
        gaMgr.trackFeedError(response.config.url, response.status);
        if (response.config.url !== fallbackURL) {
          $http.get(fallbackURL).then(handleResponse, handleError);
          return;
        }
        deferred.reject(new Error("invalid HTTP status: " + response.status));
        return;
      }
      deferred.reject(response.error);
    };

    $http.get(feedURL).then(handleResponse, handleError);
    return deferred.promise;
  };

  return {
    getFeeds: getFeeds
  };
}])

.factory('feedCache', function () {
  var CACHE_INTERVAL = 1000 * 60 * 50 * 24; // 1 day

  function cacheTimes() {
    if ('CACHE_TIMES' in localStorage) {
      return angular.fromJson(localStorage.getItem('CACHE_TIMES'));
    }
    return {};
  }

  function hasCache(name) {
    var CACHE_TIMES = cacheTimes();
    return name in CACHE_TIMES && name in localStorage && new Date().getTime() - CACHE_TIMES[name] < CACHE_INTERVAL;
  }

  return {
    set: function (name, obj) {
      var str = angular.toJson(obj);
      var compressed = LZString.compressToUTF16(str);
      localStorage.setItem(name, compressed);
      var CACHE_TIMES = cacheTimes();
      CACHE_TIMES[name] = new Date().getTime();
      localStorage.setItem('CACHE_TIMES', angular.toJson(CACHE_TIMES));
    },
    get: function (name) {
      if (hasCache(name)) {
        var compressed = localStorage.getItem(name);
        var str = LZString.decompressFromUTF16(compressed);
        return angular.fromJson(str);
      }
      return null;
    },
    hasCache: hasCache
  };
});

'use strict';

/*
Feeds directive shows localStorge cached feeds if available, and fetch server
in same time. It re-renders the feeds when remote feeds fetched, or calls
onError() if failed to fetch.
*/
angular.module('feeds-directives', []).directive('feed', ['feedService', '$compile', '$templateCache', '$http', function (feedService, $compile, $templateCache, $http) {
  return  {
    restrict: 'E',
    scope: {
      summary: '=',
      onFeedsLoaded: '&',
      onError: '&onError'
    },
    controller: ['$scope', '$element', '$attrs', '$q', '$sce', '$timeout', 'feedCache', 'gaMgr', function ($scope, $element, $attrs, $q, $sce, $timeout, feedCache, gaMgr) {
      $scope.$watch('finishedLoading', function (value) {
        if ($attrs.postRender && value) {
          $timeout(function () {
            new Function("element", $attrs.postRender + '(element);')($element);
          }, 0);
        }
      });

      var spinner = $templateCache.get('feed-spinner.html');
      $element.append($compile(spinner)($scope));

      function sanitizeFeedEntry(feedEntry) {
        feedEntry.title = $sce.trustAsHtml(feedEntry.title);
        feedEntry.contentSnippet = $sce.trustAsHtml(feedEntry.contentSnippet);
        feedEntry.content = $sce.trustAsHtml(feedEntry.content);
        feedEntry.publishedDate = new Date(feedEntry.publishedDate).getTime();
        return feedEntry;
      }

      // Add/replace below fields to an entry:
      // 1. the source field of an entry is the key of the feed, we need the feed title instead.
      // 2. if the feed one entry belongs to needs to be excluded from All tab, apply to the entry itself.
      function updateEntryFields(feedEntry, feeds) {
          var source = feedEntry.source;
          if (source) {
            var feed = feeds[source];
            feedEntry.excludeFromAll = feed.excludeFromAll;
            if (feed && feed.title) {
              feedEntry.source = feed.title;
            }
          }
      }

      function sanitizeEntries(entries, feeds) {
        for (var i = 0; i < entries.length; i++) {
          sanitizeFeedEntry(entries[i]);
          updateEntryFields(entries[i], feeds);
        }
      }

      // convert the feeds object to an array with the order specified by an array of keys.
      function sort(feeds, order) {
        var sorted = []
        for (var key in order) {
          var item = feeds[order[key]]
          if (item) {
            sorted.push(item)
          } else {
            console.error("feed " + item + " is not found in feeds!")
          }
        }
        return sorted
      }

      // feeds.entries is a list of indexes in allEntries, replace them with actual entries
      function replaceWithRealEntries(feeds, allEntries) {
        for (var i in feeds) {
          var feedEntries = feeds[i].entries
          for (var j in feedEntries) {
            feedEntries[j] = allEntries[feedEntries[j]]
          }
        }
        return feeds
      }

      var templateRendered = false;
      function renderTemplate(templateHTML) {
        if (!templateRendered) {
          $element.append($compile(templateHTML)($scope));
        }
        templateRendered = true;
      }

      function render(feedsObj) {
        sanitizeEntries(feedsObj.entries, feedsObj.feeds);
        $scope.allEntries = feedsObj.entries;
        $scope.allFeeds = replaceWithRealEntries(sort(feedsObj.feeds, feedsObj.sorted_feeds), feedsObj.entries);
        if ($attrs.templateUrl) {
          $http.get($attrs.templateUrl, {cache: $templateCache}).success(function (templateHtml) {
            renderTemplate(templateHtml);
          });
        }
        else {
          renderTemplate($templateCache.get('feed-list.html'));
        }
      }

      $attrs.$observe('url', function(url){
        var deferred = $q.defer();
        var feedsObj = feedCache.get(url);
        if (feedsObj) {
          console.log("show feeds in cache");
          render(feedsObj);
          deferred.resolve(feedsObj);
        }

        feedService.getFeeds(url, $attrs.fallbackUrl, gaMgr).then(function (feedsObj) {
          console.log("fresh copy of feeds loaded");
          feedCache.set(url, feedsObj);
          render(feedsObj);
          deferred.resolve(feedsObj);
        },function (error) {
          if (feedsObj) {
            console.log("Using cached feed");
            return;
          }
          console.error("fail to fetch feeds: " +  error);
          if ($scope.onError) {
            $scope.onError(error);
          }
          $scope.error = error;
        });

        deferred.promise.then(function(feedsObj) {
          if ($scope.onFeedsLoaded) {
            $scope.onFeedsLoaded();
          }
        }).finally(function () {
          $element.find('.spinner').slideUp();
          $scope.$evalAsync('finishedLoading = true')
        });

      });
    }]
  };
}]);

'use strict';

angular.module('feeds', ['feeds-services', 'feeds-directives']);
angular.module('feeds').run(['$templateCache', function($templateCache) {
  'use strict';

  $templateCache.put('feed-list.html',
    "<div>\n" +
    "    <div ng-show=\"error\" class=\"alert alert-danger\">\n" +
    "        <h5 class=\"text-center\">Oops... Something bad happened, please try later :(</h5>\n" +
    "    </div>\n" +
    "\n" +
    "    <ul class=\"media-list\">\n" +
    "        <li ng-repeat=\"feed in feeds | orderBy:publishedDate:reverse\" class=\"media\">\n" +
    "            <div class=\"media-body\">\n" +
    "                <h4 class=\"media-heading\"><a target=\"_new\" href=\"{{feed.link}}\" ng-bind-html=\"feed.title\"></a></h4>\n" +
    "                <p ng-bind-html=\"!summary ? feed.content : feed.contentSnippet\"></p>\n" +
    "            </div>\n" +
    "            <hr ng-if=\"!$last\"/>\n" +
    "        </li>\n" +
    "    </ul>\n" +
    "</div>"
  );


  $templateCache.put('feed-spinner.html',
    "<div class=\"spinner\">\n" +
    "    <div class=\"bar1\"></div>\n" +
    "    <div class=\"bar2\"></div>\n" +
    "    <div class=\"bar3\"></div>\n" +
    "    <div class=\"bar4\"></div>\n" +
    "    <div class=\"bar5\"></div>\n" +
    "    <div class=\"bar6\"></div>\n" +
    "    <div class=\"bar7\"></div>\n" +
    "    <div class=\"bar8\"></div>\n" +
    "</div>\n"
  );

}]);

var LANTERN_BUILD_REVISION = "d7bccd8";

'use strict';

var app = angular.module('app', [
  'app.constants',
  'ngWebSocket',
  'LocalStorageModule',
  'app.helpers',
  'pascalprecht.translate',
  'app.filters',
  'app.services',
  'app.directives',
  'ngSanitize',
  'ngResource',
  'ngclipboard',
  'infinite-scroll',
  'ng.deviceDetector',
  'ui.utils',
  'ui.showhide',
  'ui.validate',
  'ui.bootstrap',
  'ui.bootstrap.tpls',
  'feeds'
  ])
  .directive('dynamic', function ($compile) {
    return {
      restrict: 'A',
      replace: true,
      link: function (scope, ele, attrs) {
        scope.$watch(attrs.dynamic, function(html) {
          ele.html(html);
          $compile(ele.contents())(scope);
        });
      }
    };
  })
  .config(['$tooltipProvider', '$httpProvider',
                   '$resourceProvider', '$translateProvider', 'DEFAULT_LANG', function($tooltipProvider, $httpProvider,
                   $resourceProvider, $translateProvider, DEFAULT_LANG) {
      $translateProvider.useStaticFilesLoader({
        prefix: './locale/',
        suffix: '.json'
      })
      .useSanitizeValueStrategy('sanitizeParameters')
      .uniformLanguageTag('java')
      .determinePreferredLanguage()
      .fallbackLanguage(DEFAULT_LANG);

      $httpProvider.defaults.useXDomain = true;
      delete $httpProvider.defaults.headers.common["X-Requested-With"];
    //$httpProvider.defaults.headers.common['X-Requested-With'] = 'XMLHttpRequest';
    $tooltipProvider.options({
      appendToBody: true
    });
  }])
  // angular-ui config
  .value('ui.config', {
    animate: 'ui-hide',
  })
  // split array displays separates an array inside a textarea with newlines
  .directive('splitArray', function() {
      return {
          restrict: 'A',
          require: 'ngModel',
          link: function(scope, element, attr, ngModel) {

              function fromUser(text) {
                  return text.split("\n");
              }

              function toUser(array) {
                  if (array) {
                    return array.join("\n");
                  }
              }

              ngModel.$parsers.push(fromUser);
              ngModel.$formatters.push(toUser);
          }
      };
  })
  .factory('DataStream', [
    '$websocket',
    '$rootScope',
    '$interval',
    '$window',
    'Messages',
    function($websocket, $rootScope, $interval, $window, Messages) {

      var WS_RECONNECT_INTERVAL = 5000;
      var WS_RETRY_COUNT        = 0;

      var ds = $websocket('ws://' + document.location.host + '/data');

      // Register if the user navigated away, so we don't try to connect to the UI.
      // Also, force closing the websocket
      var userDidLeave = false;
      $window.onbeforeunload = function() {
        ds.close();
        userDidLeave = true;
      };

      ds.onMessage(function(raw) {
        var envelope = JSON.parse(raw.data);
        if (typeof Messages[envelope.type] != 'undefined') {
          Messages[envelope.type].call(this, envelope.message);
        } else {
          console.log('Got unknown message type: ' + envelope.type);
        };
      });

      ds.onOpen(function(msg) {
        $rootScope.wsConnected = true;
        WS_RETRY_COUNT = 0;
        $rootScope.backendIsGone = false;
        $rootScope.wsLastConnectedAt = new Date();
        console.log("New websocket instance created " + msg);
      });

      ds.onClose(function(msg) {
        $rootScope.wsConnected = false;

        console.log("This websocket instance closed " + msg);

        // If the user left, then don't try to reconnect. Causes a known bug lantern-#2721
        // where some browsers will reconnect when navigating away, returning to Lantern
        // home page
        if (userDidLeave) {
          return;
        }

        // Temporary workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1192773
        if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
          $rootScope.backendIsGone = true;
          $rootScope.$digest()
        } else {
          // Try to reconnect indefinitely when the websocket closes
          $interval(function() {
            console.log("Trying to reconnect to disconnected websocket");
            ds = $websocket('ws://' + document.location.host + '/data');
            ds.onOpen(function(msg) {
              $window.location.reload();
            });
          }, WS_RECONNECT_INTERVAL);
        }
      });

      ds.onError(function(msg) {
          console.log("Error on this websocket instance " + msg);
      });

      var methods = {
        'send': function(messageType, data) {
          console.log('request to send.');
          ds.send(JSON.stringify({'Type': messageType, 'Message': data}))
        }
      };

      return methods;
    }
  ])
  .run(['$filter', '$log', '$rootScope', '$timeout', '$window', '$websocket',
       '$translate', '$http', 'apiSrvc', 'gaMgr', 'modelSrvc', 'ENUMS', 'EXTERNAL_URL', 'MODAL', 'CONTACT_FORM_MAXLEN',
       function($filter, $log, $rootScope, $timeout, $window, $websocket,
                $translate, $http, apiSrvc, gaMgr, modelSrvc, ENUMS, EXTERNAL_URL, MODAL, CONTACT_FORM_MAXLEN) {

    var CONNECTIVITY = ENUMS.CONNECTIVITY,
        MODE = ENUMS.MODE,
        jsonFltr = $filter('json'),
        model = modelSrvc.model,
        prettyUserFltr = $filter('prettyUser'),
        reportedStateFltr = $filter('reportedState');

    // for easier inspection in the JavaScript console
    $window.rootScope = $rootScope;
    $window.model = model;

    $rootScope.EXTERNAL_URL = EXTERNAL_URL;

    $rootScope.model = model;
    $rootScope.DEFAULT_AVATAR_URL = 'img/default-avatar.png';
    $rootScope.CONTACT_FORM_MAXLEN = CONTACT_FORM_MAXLEN;

    angular.forEach(ENUMS, function(val, key) {
      $rootScope[key] = val;
    });

    $rootScope.reload = function () {
      location.reload(true); // true to bypass cache and force request to server
    };

    $rootScope.switchLang = function (lang) {
        $rootScope.lang = lang;
        $translate.use(lang);
    };

    $rootScope.enableTracking = function() {
      gaMgr.enable();
    };

    $rootScope.disableTracking = function() {
      gaMgr.disable();
    };

    $rootScope.valByLang = function(name) {
        // use language-specific forums URL
        if (name && $rootScope.lang &&
            name.hasOwnProperty($rootScope.lang)) {
            return name[$rootScope.lang];
        }
        // default to English language forum
        return name['en_US'];
    };

    $rootScope.changeLang = function(lang) {
      return $rootScope.interaction(INTERACTION.changeLang, {lang: lang});
    };

    $rootScope.openRouterConfig = function() {
      return $rootScope.interaction(INTERACTION.routerConfig);
    };

    $rootScope.openExternal = function(url) {
      return $window.open(url);
    };

    $rootScope.resetContactForm = function (scope) {
      if (scope.show) {
        var reportedState = jsonFltr(reportedStateFltr(model));
        scope.diagnosticInfo = reportedState;
      }
    };

    $rootScope.interactionWithNotify = function (interactionid, scope, reloadAfter) {
      var extra;
      if (scope.notify) {
        var diagnosticInfo = scope.diagnosticInfo;
        if (diagnosticInfo) {
          try {
            diagnosticInfo = angular.fromJson(diagnosticInfo);
          } catch (e) {
            $log.debug('JSON decode diagnosticInfo', diagnosticInfo, 'failed, passing as-is');
          }
        }
        extra = {
          context: model.modal,
          message: scope.message,
          diagnosticInfo: diagnosticInfo
        };
      }
      $rootScope.interaction(interactionid, extra).then(function () {
        if (reloadAfter) $rootScope.reload();
      });
    };

    $rootScope.backendIsGone = false;
    $rootScope.$watch("wsConnected", function(wsConnected) {
      var MILLIS_UNTIL_BACKEND_CONSIDERED_GONE = 10000;
      if (!wsConnected) {
        // Temporary workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1192773
        if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
          $rootScope.backendIsGone = true;
        } else {
          // In 11 seconds, check if we're still not connected
          $timeout(function() {
            var lastConnectedAt = $rootScope.wsLastConnectedAt;
            if (lastConnectedAt) {
              var timeSinceLastConnected = new Date().getTime() - lastConnectedAt.getTime();
              $log.debug("Time since last connect", timeSinceLastConnected);
              if (timeSinceLastConnected > MILLIS_UNTIL_BACKEND_CONSIDERED_GONE) {
                // If it's been more than 10 seconds since we last connect,
                // treat the backend as gone
                console.log("Backend is gone");
                $rootScope.backendIsGone = true;
              } else {
                $rootScope.backendIsGone = false;
              }
            }
          }, MILLIS_UNTIL_BACKEND_CONSIDERED_GONE + 1000);
        }
      }
    });

  }]);

app.filter('urlencode', function() {
    return window.encodeURIComponent;
});

'use strict';

function makeEnum(keys, extra) {
  var obj = {};
  for (var i=0, key=keys[i]; key; key=keys[++i]) {
    obj[key] = key;
  }
  if (extra) {
    for (var key in extra)
      obj[key] = extra[key];
  }
  return obj;
}

var DEFAULT_LANG = 'en_US',
    DEFAULT_DIRECTION = 'ltr',
    LANGS = {
      // http://www.omniglot.com/language/names.htm
      en_US: {dir: 'ltr', name: 'English'},
      de: {dir: 'ltr', name: 'Deutsch'},
      fr_FR: {dir: 'ltr', name: 'français (France)'},
      fr_CA: {dir: 'ltr', name: 'français (Canada)'},
      ca: {dir: 'ltr', name: 'català'},
      pt_BR: {dir: 'ltr', name: 'português'},
      fa_IR: {dir: 'rtl', name: 'پارسی'},
      zh_CN: {dir: 'ltr', name: '中文'},
      nl: {dir: 'ltr', name: 'Nederlands'},
      sk: {dir: 'ltr', name: 'slovenčina'},
      cs: {dir: 'ltr', name: 'čeština'},
      sv: {dir: 'ltr', name: 'Svenska'},
      ja: {dir: 'ltr', name: '日本語'},
      uk: {dir: 'ltr', name: 'Українська (діаспора)'},
      uk_UA: {dir: 'ltr', name: 'Українська (Україна)'},
      ru_RU: {dir: 'ltr', name: 'Русский язык'},
      es: {dir: 'ltr', name: 'español'},
      ar: {dir: 'rtl', name: 'العربية'}
    },
    GOOGLE_ANALYTICS_WEBPROP_ID = 'UA-21815217-13',
    GOOGLE_ANALYTICS_DISABLE_KEY = 'ga-disable-'+GOOGLE_ANALYTICS_WEBPROP_ID,
    loc = typeof location == 'object' ? location : undefined,
    // this allows the real backend to mount the entire app under a random path
    // for security while the mock backend can always use '/app':
    APP_MOUNT_POINT = loc ? loc.pathname.split('/')[1] : 'app',
    API_MOUNT_POINT = 'api',
    COMETD_MOUNT_POINT = 'cometd',
    COMETD_URL = loc && loc.protocol+'//'+loc.host+'/'+APP_MOUNT_POINT+'/'+COMETD_MOUNT_POINT,
    REQUIRED_API_VER = {major: 0, minor: 0}, // api version required by frontend
    REQ_VER_STR = [REQUIRED_API_VER.major, REQUIRED_API_VER.minor].join('.'),
    API_URL_PREFIX = ['', APP_MOUNT_POINT, API_MOUNT_POINT, REQ_VER_STR].join('/'),
    MODEL_SYNC_CHANNEL = '/sync',
    CONTACT_FORM_MAXLEN = 500000,
    INPUT_PAT = {
      // based on http://www.regular-expressions.info/email.html
      EMAIL: /^[a-zA-Z0-9._%+-]+@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/,
      EMAIL_INSIDE: /[a-zA-Z0-9._%+-]+@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/,
      // from http://html5pattern.com/
      DOMAIN: /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,6}$/,
      IPV4: /((^|\.)((25[0-5])|(2[0-4]\d)|(1\d\d)|([1-9]?\d))){4}$/
    },
    EXTERNAL_URL = {
      rally: 'https://rally.org/lantern/donate',
      cloudServers: 'https://github.com/getlantern/lantern/wiki/Lantern-Cloud-Servers',
      autoReportPrivacy: 'https://github.com/getlantern/lantern/wiki/Privacy#wiki-optional-information',
      homepage: 'https://www.getlantern.org/',
      userForums: {
        en_US: 'https://groups.google.com/group/lantern-users-en',
        fr_FR: 'https://groups.google.com/group/lantern-users-fr',
        fr_CA: 'https://groups.google.com/group/lantern-users-fr',
        ar: 'https://groups.google.com/group/lantern-users-ar',
        fa_IR: 'https://groups.google.com/group/lantern-users-fa',
        zh_CN: 'https://lanternforum.greatfire.org/'
      },
      docs: 'https://github.com/getlantern/lantern/wiki',
      getInvolved: 'https://github.com/getlantern/lantern/wiki/Get-Involved',
      proxiedSitesWiki: 'https://github.com/getlantern/lantern-proxied-sites-lists/wiki',
      developers: 'https://github.com/getlantern/lantern'
    },
    // enums
    MODE = makeEnum(['give', 'get', 'unknown']),
    OS = makeEnum(['windows', 'linux', 'osx']),
    MODAL = makeEnum([
      'settingsLoadFailure',
      'unexpectedState', // frontend only
      'welcome',
      'authorize',
      'connecting',
      'notInvited',
      'proxiedSites',
      'lanternFriends',
      'finished',
      'contact',
      'settings',
      'confirmReset',
      'giveModeForbidden',
      'about',
      'sponsor',
      'sponsorToContinue',
      'updateAvailable',
      'scenarios'],
      {none: ''}),
    INTERACTION = makeEnum([
      'changeLang',
      'give',
      'get',
      'set',
      'lanternFriends',
      'friend',
      'reject',
      'contact',
      'settings',
      'reset',
      'proxiedSites',
      'about',
      'sponsor',
      'updateAvailable',
      'retry',
      'cancel',
      'continue',
      'close',
      'quit',
      'refresh',
      'unexpectedStateReset',
      'unexpectedStateRefresh',
      'url',
      'developer',
      'scenarios',
      'routerConfig']),
    SETTING = makeEnum([
      'lang',
      'mode',
      'autoReport',
      'runAtSystemStart',
      'systemProxy',
      'proxyAllSites',
      'proxyPort',
      'proxiedSites']),
    PEER_TYPE = makeEnum([
      'pc',
      'cloud',
      'laeproxy'
      ]),
    FRIEND_STATUS = makeEnum([
      'friend',
      'pending',
      'rejected'
      ]),
    CONNECTIVITY = makeEnum([
      'notConnected',
      'connecting',
      'connected']),
    GTALK_STATUS = makeEnum([
      'offline',
      'unavailable',
      'idle',
      'available']),
    SUGGESTION_REASON = makeEnum([
      'runningLantern',
      'friendedYou'
      ]),
    ENUMS = {
      MODE: MODE,
      OS: OS,
      MODAL: MODAL,
      INTERACTION: INTERACTION,
      SETTING: SETTING,
      PEER_TYPE: PEER_TYPE,
      FRIEND_STATUS: FRIEND_STATUS,
      CONNECTIVITY: CONNECTIVITY,
      GTALK_STATUS: GTALK_STATUS,
      SUGGESTION_REASON: SUGGESTION_REASON
    };

if (typeof angular == 'object' && angular && typeof angular.module == 'function') {
  angular.module('app.constants', [])
    .constant('DEFAULT_LANG', DEFAULT_LANG)
    .constant('DEFAULT_DIRECTION', DEFAULT_DIRECTION)
    .constant('LANGS', LANGS)
    .constant('API_MOUNT_POINT', API_MOUNT_POINT)
    .constant('APP_MOUNT_POINT', APP_MOUNT_POINT)
    .constant('COMETD_MOUNT_POINT', COMETD_MOUNT_POINT)
    .constant('COMETD_URL', COMETD_URL)
    .constant('MODEL_SYNC_CHANNEL', MODEL_SYNC_CHANNEL)
    .constant('CONTACT_FORM_MAXLEN', CONTACT_FORM_MAXLEN)
    .constant('INPUT_PAT', INPUT_PAT)
    .constant('EXTERNAL_URL', EXTERNAL_URL)
    .constant('ENUMS', ENUMS)
    .constant('MODE', MODE)
    .constant('OS', OS)
    .constant('MODAL', MODAL)
    .constant('INTERACTION', INTERACTION)
    .constant('SETTING', SETTING)
    .constant('PEER_TYPE', PEER_TYPE)
    .constant('FRIEND_STATUS', FRIEND_STATUS)
    .constant('CONNECTIVITY', CONNECTIVITY)
    .constant('GTALK_STATUS', GTALK_STATUS)
    .constant('SUGGESTION_REASON', SUGGESTION_REASON)
    // frontend-only
    .constant('GOOGLE_ANALYTICS_WEBPROP_ID', GOOGLE_ANALYTICS_WEBPROP_ID)
    .constant('GOOGLE_ANALYTICS_DISABLE_KEY', GOOGLE_ANALYTICS_DISABLE_KEY)
    .constant('LANTERNUI_VER', window.LANTERNUI_VER) // set in version.js
    .constant('REQUIRED_API_VER', REQUIRED_API_VER)
    .constant('BUILD_REVISION', LANTERN_BUILD_REVISION)
    .constant('API_URL_PREFIX', API_URL_PREFIX);
} else if (typeof exports == 'object' && exports && typeof module == 'object' && module && module.exports == exports) {
  module.exports = {
    DEFAULT_LANG: DEFAULT_LANG,
    DEFAULT_DIRECTION: DEFAULT_DIRECTION,
    LANGS: LANGS,
    API_MOUNT_POINT: API_MOUNT_POINT,
    APP_MOUNT_POINT: APP_MOUNT_POINT,
    COMETD_MOUNT_POINT: COMETD_MOUNT_POINT,
    COMETD_URL: COMETD_URL,
    MODEL_SYNC_CHANNEL: MODEL_SYNC_CHANNEL,
    CONTACT_FORM_MAXLEN: CONTACT_FORM_MAXLEN,
    INPUT_PAT: INPUT_PAT,
    EXTERNAL_URL: EXTERNAL_URL,
    ENUMS: ENUMS,
    MODE: MODE,
    OS: OS,
    MODAL: MODAL,
    INTERACTION: INTERACTION,
    SETTING: SETTING,
    PEER_TYPE: PEER_TYPE,
    FRIEND_STATUS: FRIEND_STATUS,
    CONNECTIVITY: CONNECTIVITY,
    GTALK_STATUS: GTALK_STATUS,
    SUGGESTION_REASON: SUGGESTION_REASON
  };
}

'use strict';

if (typeof inspect != 'function') {
  try {
    var inspect = require('util').inspect;
  } catch (e) {
    var inspect = function(x) { return JSON.stringify(x); };
  }
}

if (typeof _ != 'function') {
  var _ = require('../bower_components/lodash/lodash.min.js')._;
}

if (typeof jsonpatch != 'object') {
  var jsonpatch = require('../bower_components/jsonpatch/lib/jsonpatch.js');
}
var JSONPatch = jsonpatch.JSONPatch,
    JSONPointer = jsonpatch.JSONPointer,
    PatchApplyError = jsonpatch.PatchApplyError,
    InvalidPatch = jsonpatch.InvalidPatch;

function makeLogger(prefix) {
  return function() {
    var s = '[' + prefix + '] ';
    for (var i=0, l=arguments.length, ii=arguments[i]; i<l; ii=arguments[++i])
      s += (_.isObject(ii) ? inspect(ii, false, null, true) : ii)+' ';
    console.log(s);
  };
}

var log = makeLogger('helpers');

var byteDimensions = {P: 1024*1024*1024*1024*1024, T: 1024*1024*1024*1024, G: 1024*1024*1024, M: 1024*1024, K: 1024, B: 1};
function byteDimension(nbytes) {
  var dim, base;
  for (dim in byteDimensions) { // assumes largest units first
    base = byteDimensions[dim];
    if (nbytes > base) break;
  }
  return {dim: dim, base: base};
}

function randomChoice(collection) {
  if (_.isArray(collection))
    return collection[_.random(0, collection.length-1)];
  if (_.isPlainObject(collection))
    return randomChoice(_.keys(collection));
  throw new TypeError('expected array or plain object, got '+typeof collection);
}

function applyPatch(obj, patch) {
  patch = new JSONPatch(patch, true); // mutate = true
  patch.apply(obj);
}

function getByPath(obj, path) {
  try {
    return (new JSONPointer(path)).get(obj);
  } catch (e) {
    if (!(e instanceof PatchApplyError)) throw e;
  }
}

var _export = [makeLogger, byteDimension, randomChoice, applyPatch, getByPath];
if (typeof angular == 'object' && angular && typeof angular.module == 'function') {
  var module = angular.module('app.helpers', []);
  _.each(_export, function(func) {
    module.constant(func.name, func);
  });
} else if (typeof exports == 'object' && exports && typeof module == 'object' && module && module.exports == exports) {
  _.each(_export, function(func) {
    exports[func.name] = func;
  });
}

'use strict';

angular.module('app.filters', [])
  // see i18n.js for i18n filter
  .filter('upper', function() {
    return function(s) {
      return angular.uppercase(s);
    };
  })
  .filter('badgeCount', function() {
    return function(str, max) {
      var count = parseInt(str), max = max || 9;
      return count > max ? max + '+' : count;
    };
  })
  .filter('noNullIsland', function() {
    return function(peers) {
      return _.reject(peers, function (peer) {
        return peer.lat === 0.0 && peer.lon === 0.0;
      });
    };
  })
  .filter('prettyUser', function() {
    return function(obj) {
      if (!obj) return obj;
      if (obj.email && obj.name)
        return obj.name + ' <' + obj.email + '>'; // XXX i18n?
      return obj.email;
    };
  })
  .filter('prettyBytes', function($filter) {
    return function(nbytes, dimensionInput, showUnits) {
      if (_.isNaN(nbytes)) return nbytes;
      if (_.isUndefined(dimensionInput)) dimensionInput = nbytes;
      if (_.isUndefined(showUnits)) showUnits = true;
      var dimBase = byteDimension(dimensionInput),
          dim = dimBase.dim,
          base = dimBase.base,
          quotient = $filter('number')(nbytes / base, 1);
      return showUnits ? quotient+' '+dim // XXX i18n?
                       : quotient;
    };
  })
  .filter('prettyBps', function($filter) {
    return function(nbytes, dimensionInput, showUnits) {
      if (_.isNaN(nbytes)) return nbytes;
      if (_.isUndefined(showUnits)) showUnits = true;
      var bytes = $filter('prettyBytes')(nbytes, dimensionInput, showUnits);
      return showUnits ? bytes+'/'+'s' // XXX i18n?
                       : bytes;
    };
  })
  .filter('reportedState', function() {
    return function(model) {
      var state = _.cloneDeep(model);

      // omit these fields
      state = _.omit(state, 'mock', 'countries', 'global');
      delete state.location.lat;
      delete state.location.lon;
      delete state.connectivity.ip;

      // only include these fields from the user's profile
      if (state.profile) {
        state.profile = {email: state.profile.email, name: state.profile.name};
      }

      // replace these array fields with their lengths
      _.each(['/roster', '/settings/proxiedSites', '/friends'], function(path) {
        var len = (getByPath(state, path) || []).length;
        if (len) applyPatch(state, [{op: 'replace', path: path, value: len}]);
      });

      var peers = getByPath(state, '/peers');
      _.each(peers, function (peer) {
        peer.rosterEntry = !!peer.rosterEntry;
        delete peer.peerid;
        delete peer.ip;
        delete peer.lat;
        delete peer.lon;
      });

      return state;
    };
  })
  .filter('version', function() {
    return function(versionObj, tag, git) {
      if (!versionObj) return versionObj;
      var components = [versionObj.major, versionObj.minor, versionObj.patch],
          versionStr = components.join('.');
      if (!tag) return versionStr;
      if (versionObj.tag) versionStr += '-'+versionObj.tag;
      if (!git) return versionStr;
      if (versionObj.git) versionStr += ' ('+versionObj.git.substring(0, 7)+')';
      return versionStr;
    };
  });

'use strict';

angular.module('app.services', [])
  // Messages service will return a map of callbacks that handle websocket
  // messages sent from the flashlight process.
  .service('Messages', function($rootScope, modelSrvc) {

    var model = modelSrvc.model;
    model.instanceStats = {
      allBytes: {
        rate: 0,
      },
    };
    model.peers = [];
    var flashlightPeers = {};
    var queuedFlashlightPeers = {};

    var connectedExpiration = 15000;
    function setConnected(peer) {
      // Consider peer connected if it's been fewer than x seconds since
      // lastConnected
      var lastConnected = Date.parse(peer.lastConnected);
      var delta = new Date().getTime() - Date.parse(peer.lastConnected);
      peer.connected = delta < connectedExpiration;
    }

    // Update last connected for all peers every 10 seconds
    setInterval(function() {
      $rootScope.$apply(function() {
        _.forEach(model.peers, setConnected);
      });
    }, connectedExpiration);

    function applyPeer(peer) {
      // Always set mode to give
      peer.mode = 'give';

      setConnected(peer);

      // Update bpsUpDn
      var peerid = peer.peerid;
      var oldPeer = flashlightPeers[peerid];

      var bpsUpDnDelta = peer.bpsUpDn;
      if (oldPeer) {
        // Adjust bpsUpDnDelta by old value
        bpsUpDnDelta -= oldPeer.bpsUpDn;
        // Copy over old peer so that Angular can detect the change
        angular.copy(peer, oldPeer);
      } else {
        // Add peer to model
        flashlightPeers[peerid] = peer;
        model.peers.push(peer);
      }
      model.instanceStats.allBytes.rate += bpsUpDnDelta;
    }

    var fnList = {
      'settings': function(settings) {
        console.log('Got Lantern default settings: ', settings);
        if (settings && settings.version) {
            // configure settings
            // set default client to get-mode
            model.settings = {};
            model.settings.mode = 'get';
            model.settings.version = settings.version + " (" + settings.revisionDate + ")";
        }

        if (settings.autoReport) {
          model.settings.autoReport = true;
          $rootScope.enableTracking();
        } else {
          $rootScope.disableTracking();
        }

        if (settings.autoLaunch) {
          model.settings.autoLaunch = true;
        }

        if (settings.proxyAll) {
          model.settings.proxyAll = true;
        }

        if (settings.systemProxy) {
          model.settings.systemProxy = true;
        }

        if (settings.redirectTo) {
          console.log('Redirecting UI to: ' + settings.redirectTo);
          window.location = settings.redirectTo;
        }
      },
      'bandwidth': function(bandwidth) {
        console.log('Got bandwidth data: ', bandwidth);
      },
      'localDiscovery': function(data) {
        model.localLanterns = data;
      },
    };

    return fnList;
  })
  .service('modelSrvc', function($rootScope, apiSrvc, $window, MODEL_SYNC_CHANNEL) {
      var model = {},
        syncSubscriptionKey;

    $rootScope.validatedModel = false;

    // XXX use modelValidatorSrvc to validate update before accepting
    function handleSync(msg) {
      var patch = msg.data;
      // backend can send updates before model has been populated
      // https://github.com/getlantern/lantern/issues/587
      if (patch[0].path !== '' && _.isEmpty(model)) {
        //log.debug('ignoring', msg, 'while model has not yet been populated');
        return;
      }

      function updateModel() {
        var shouldUpdateInstanceStats = false;
        if (patch[0].path === '') {
            // XXX jsonpatch can't mutate root object https://github.com/dharmafly/jsonpatch.js/issues/10
            angular.copy(patch[0].value, model);
          } else {
            try {
                applyPatch(model, patch);
                for (var i=0; i<patch.length; i++) {
                    if (patch[i].path == "/instanceStats") {
                        shouldUpdateInstanceStats = true;
                        break;
                      }
                  }
                } catch (e) {
                  if (!(e instanceof PatchApplyError || e instanceof InvalidPatch)) throw e;
                  //log.error('Error applying patch', patch);
                  apiSrvc.exception({exception: e, patch: patch});
                }
            }
        }

        if (!$rootScope.validatedModel) {
            $rootScope.$apply(updateModel());
            $rootScope.validatedModel = true
        } else {
            updateModel();
        }
      }

    syncSubscriptionKey = {chan: MODEL_SYNC_CHANNEL, cb: handleSync};

    return {
      model: model,
      sane: true
    };
  })
  .service('gaMgr', function ($window, DataStream, GOOGLE_ANALYTICS_DISABLE_KEY, GOOGLE_ANALYTICS_WEBPROP_ID) {
    window.gaDidInit = false;

    var enabled = false;

    // Under certain circumstances this "window.ga" function was not available
    // when loading Safari. See
    // https://github.com/getlantern/lantern/issues/3560
    var ga = function() {
      var ga = $window.ga;
      if (ga) {
        if (!enabled) {
          return function() {
            console.log("ga is disabled.")
          }
        }
        if (!$window.gaDidInit) {
          $window.gaDidInit = true;
          ga('create', GOOGLE_ANALYTICS_WEBPROP_ID, {cookieDomain: 'none'});
          ga('set', {
            anonymizeIp: true,
            forceSSL: true,
            location: 'http://lantern-ui/',
            hostname: 'lantern-ui',
            title: 'lantern-ui'
          });
          trackPageView(); // Only happens once.
        }
        return ga;
      }
      return function() {
        console.log("ga is not defined.");
      }
    }

    var trackPageView = function() {
      console.log("Tracked page view.");
      ga()('send', 'pageview');
    };

    var trackSendLinkToMobile = function() {
      ga()('send', 'event', 'send-lantern-mobile-email');
    };

    var trackCopyLink = function() {
      ga()('send', 'event', 'copy-lantern-mobile-link');
    };

    var trackSocialLink = function(name) {
      ga()('send', 'event', 'social-link-' + name);
    };

    var trackLink = function(name) {
      ga()('send', 'event', 'link-' + name);
    };

    var trackBookmark = function(name) {
      ga()('send', 'event', 'bookmark-' + name);
    };

    var trackShowFeed = function() {
      ga()('send', 'event', 'showFeed');
    };

    var trackHideFeed = function() {
      ga()('send', 'event', 'hideFeed');
    };

    var trackFeed = function(name) {
      ga()('send', 'event', 'feed-' + name);
    };

    var trackFeedError = function(url, statusCode) {
      var eventName = 'feed-loading-error-' + url + "-status-"+statusCode;
      ga()('send', 'event', eventName);
    };

    var enableTracking = function() {
      console.log("enabling ga.")
      enabled = true;
      ga(); // this will send the pageview, if not previously sent.
    };

    var disableTracking = function() {
      console.log("disabling ga.")
      enabled = false;
    };

    return {
      enable: enableTracking,
      disable: disableTracking,
      trackSendLinkToMobile: trackSendLinkToMobile,
      trackCopyLink: trackCopyLink,
      trackPageView: trackPageView,
      trackSocialLink: trackSocialLink,
      trackLink: trackLink,
      trackBookmark: trackBookmark,
      trackFeed: trackFeed,
      trackFeedError: trackFeedError,
      trackShowFeed: trackShowFeed,
      trackHideFeed: trackHideFeed
    };
  })
  .service('apiSrvc', function($http, API_URL_PREFIX) {
    return {
      exception: function(data) {
        return $http.post(API_URL_PREFIX+'/exception', data);
      },
      interaction: function(interactionid, data) {
        var url = API_URL_PREFIX+'/interaction/'+interactionid;
        return $http.post(url, data);
      }
    };
  });

'use strict';

app.controller('RootCtrl', ['$rootScope', '$scope', '$filter', '$compile', '$window', '$http', 'gaMgr', '$translate',
               'localStorageService', 'BUILD_REVISION',
               function($rootScope, $scope, $filter, $compile, $window, $http, gaMgr, $translate, localStorageService, BUILD_REVISION) {
    $scope.currentModal = 'none';

    $rootScope.lanternShowNews = 'lanternShowNewsFeed';
    $rootScope.lanternFirstTimeBuildVar = 'lanternFirstTimeBuild-'+BUILD_REVISION;
    $rootScope.lanternHideMobileAdVar = 'lanternHideMobileAd';

    $scope.loadScript = function(src) {
        (function() {
            var script  = document.createElement("script")
            script.type = "text/javascript";
            script.src  = src;
            script.async = true;
            var x = document.getElementsByTagName('script')[0];
            x.parentNode.insertBefore(script, x);
        })();
    };
    $scope.loadShareScripts = function() {
        if (!$window.twttr) {
            // inject twitter share widget script
          $scope.loadScript('//platform.twitter.com/widgets.js');
          // load FB share script
          $scope.loadScript('//connect.facebook.net/en_US/sdk.js#appId=1562164690714282&xfbml=1&version=v2.3');
        }
    };

    $scope.showModal = function(val) {
      $scope.closeModal();

      if (val == 'welcome') {
        $scope.loadShareScripts();
      } else {
        $('<div class="modal-backdrop"></div>').appendTo(document.body);
      }

      $scope.currentModal = val;
    };

    $scope.$watch('model.email', function(email) {
      $scope.email = email;
    });

    $scope.resetPlaceholder = function() {
      $scope.inputClass = "";
      $scope.inputPlaceholder = "you@example.com";
    }

    $rootScope.mobileAdImgPath = function(name) {
      var mapTable = {
        'zh_CN': 'zh',
        'zh': 'zh',
        'fa_IR': 'fa',
        'fa': 'fa'
      };
      var lang = $translate.use();
      lang = mapTable[lang] || 'en';
      return '/img/mobile-ad/' + lang + '/' + name;
    }

    $rootScope.setShowMobileAd = function() {
      $rootScope.showMobileAd = true;
    }

    $rootScope.hideMobileAd = function() {
      $rootScope.showMobileAd = false;
      localStorageService.set($rootScope.lanternHideMobileAdVar, true);
    };

    $rootScope.mobileAppLink = function() {
      return "https://bit.ly/lanternapk";
    };

    $rootScope.mobileShareContent = function() {
      var fmt = $filter('translate')('LANTERN_MOBILE_SHARE');
      return fmt.replace("%s", $rootScope.mobileAppLink());
    };

    $rootScope.sendMobileAppLink = function() {
      var email = $scope.email;

      $scope.resetPlaceholder();

      if (!email || !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        $scope.inputClass = "fail";
        var t = $filter('translate');
        $scope.inputPlaceholder = t("LANTERN_MOBILE_ENTER_VALID_EMAIL");
        alert(t("LANTERN_MOBILE_CHECK_EMAIL"));
        return;
      }

      mailer.send({
        'to': email,
        'template': 'lantern-mobile-message'
      });

      $rootScope.hideMobileAd();

      $scope.showModal("lantern-mobile-ad");

      gaMgr.trackSendLinkToMobile();
    };


    $scope.trackBookmark = function(name) {
      return gaMgr.trackBookmark(name);
    };

    $scope.trackLink = function(name) {
      return gaMgr.trackLink(name);
    };

    $scope.closeModal = function() {
      $rootScope.hideMobileAd();

      $scope.currentModal = 'none';
      $(".modal-backdrop").remove();
    };

    if (!localStorageService.get($rootScope.lanternFirstTimeBuildVar)) {
      // Force showing Ad.
      localStorageService.set($rootScope.lanternHideMobileAdVar, "");
      // Saving first time run.
      localStorageService.set($rootScope.lanternFirstTimeBuildVar, true);
    };


    $rootScope.showError = false;
    $rootScope.showBookmarks = true;
}]);

app.controller('SettingsCtrl', ['$scope', 'MODAL', 'DataStream', 'gaMgr', function($scope, MODAL, DataStream, gaMgr) {
  $scope.show = false;

  $scope.$watch('model.modal', function (modal) {
    $scope.show = modal === MODAL.settings;
  });

  $scope.changeReporting = function(value) {
      DataStream.send('settings', {autoReport: value});
  };

  $scope.changeAutoLaunch = function(value) {
      DataStream.send('settings', {autoLaunch: value});
  }

  $scope.changeProxyAll = function(value) {
      DataStream.send('settings', {proxyAll: value});
  }

  $scope.changeSystemProxy = function(value) {
      DataStream.send('settings', {systemProxy: value});
  }

  $scope.$watch('model.settings.systemProxy', function(value) {
    $scope.systemProxy = value;
  });

  $scope.$watch('model.settings.proxyAll', function(value) {
    $scope.proxyAllSites = value;
  });
}]);

app.controller('MobileAdCtrl', ['$scope', 'MODAL', 'gaMgr', function($scope, MODAL, gaMgr) {
  $scope.show = false;

  $scope.$watch('model.modal', function (modal) {
    $scope.show = modal === MODAL.settings;
  });

  $scope.copyAndroidMobileLink = function() {
    $scope.linkCopied = true;
    gaMgr.trackCopyLink();
  };

  $scope.trackSocialLink = function(name) {
    gaMgr.trackSocialLink(name);
  };

  $scope.trackLink = function(name) {
    gaMgr.trackLink(name);
  };

}]);

app.controller('NewsfeedCtrl', ['$scope', '$rootScope', '$translate', 'gaMgr', 'localStorageService', function($scope, $rootScope, $translate, gaMgr, localStorageService) {
  $rootScope.showNewsfeed = function() {
    $rootScope.showNews = true;
    localStorageService.set($rootScope.lanternShowNews, true);
    $rootScope.showMobileAd = false;
    $rootScope.showBookmarks = false;
    gaMgr.trackShowFeed();
  };
  $rootScope.hideNewsfeed = function() {
    $rootScope.showNews = false;
    localStorageService.set($rootScope.lanternShowNews, false);
    $rootScope.showMobileAd = false;
    $rootScope.showBookmarks = true;
    $rootScope.showError = false;
    gaMgr.trackHideFeed();
  };
  $rootScope.showNewsfeedError = function() {
    console.log("Newsfeed error");
    // If we're currently in newsfeed mode, we want to show the error
    // and also not show the bookmarks, as otherwise the two will
    // overlap.
    if ($rootScope.showNews) {
      $rootScope.showBookmarks = false;
    }
    $rootScope.showNews = false;
    $rootScope.enableShowError();
  };

  // Note local storage stores everything as strings.
  if (localStorageService.get($rootScope.lanternShowNews) === "true") {
    console.log("local storage set to show the feed");

    // We just set the variable directly here to skip analytics, local
    // storage, etc.
    $rootScope.showNews = true;
  } else {
    console.log("local storage NOT set to show the feed");
    $rootScope.showNews = false;
  }

  // The function for determing the URL of the feed. Note this is watched
  // elsewhere so will get called a lot, but it's just calculating the url
  // string so is cheap.
  $scope.feedUrl = function() {
    var mapTable = {
      'fa': 'fa_IR',
      'zh': 'zh_CN'
    };
    var lang = $translate.use();
    lang = mapTable[lang] || lang;
    var url = "/feed?lang="+lang;
    return url;
  }
}]);

app.controller('FeedTabCtrl', ['$scope', '$rootScope', '$translate', function($scope, $rootScope, $translate) {
  $scope.tabActive = {};
  $scope.selectTab = function (title) {
    $scope.tabActive[title] = true;
  };
  $scope.deselectTab = function (title) {
    $scope.tabActive[title] = false;
  };
  $scope.tabSelected = function (title) {
    return $scope.tabActive[title] === true;
  };
}]);

app.controller('FeedCtrl', ['$scope', 'gaMgr', function($scope, gaMgr) {
  var copiedFeedEntries = [];
  angular.copy($scope.feedEntries, copiedFeedEntries);
  $scope.entries = [];
  $scope.containerId = function($index) {
    return "#feeds-container-" + $index;
  };
  var count = 0;
  $scope.tabVisible = function() {
    return $scope.tabSelected($scope.feedsTitle);
  };
  $scope.addMoreItems = function() {
    if ($scope.tabVisible()) {
      var more = copiedFeedEntries.splice(0, 10);
      $scope.entries = $scope.entries.concat(more);
      //console.log($scope.feedsTitle + ": added " + more.length + " entries, total " + $scope.entries.length);
    }
  };
  $scope.renderContent = function(feed) {
    if (feed.meta && feed.meta.description) {
      return feed.meta.description;
    }
    return feed.contentSnippetText;
  };
  $scope.trackFeed = function(name) {
    return gaMgr.trackFeed(name);
  };
  $scope.hideImage = function(feed) {
    feed.image = null;
  };
  $scope.addMoreItems();
}]);

app.controller('ErrorCtrl', ['$scope', '$rootScope', 'gaMgr', '$sce', '$translate', "deviceDetector",
  function($scope, $rootScope, gaMgr, $sce, $translate, deviceDetector) {
    // TOOD: notify GA we've hit the error page!

    $scope.isMac = function() {
      return deviceDetector.os == "mac";
    }

    $scope.isWindows = function() {
      return deviceDetector.os == "windows";
    }

    $scope.isWindowsXp = function() {
      return deviceDetector.os == "windows" &&
        deviceDetector.os_version == "windows-xp"
    }

    $scope.isLinux = function() {
      return deviceDetector.os == "linux";
    }

    $rootScope.enableShowError = function() {
      $rootScope.showError = true;
      gaMgr.trackFeed("error");
    }

    $scope.showProxyOffHelp = false;
    $scope.showExtensionHelp = false;
    $scope.showXunleiHelp = false;
    $scope.showConnectionHelp = false;

    $scope.toggleShowProxyOffHelp = function() {
      $scope.showProxyOffHelp = !$scope.showProxyOffHelp;
    }
    $scope.toggleShowExtensionHelp = function() {
      $scope.showExtensionHelp = !$scope.showExtensionHelp;
    }
    $scope.toggleShowXunleiHelp = function() {
      $scope.showXunleiHelp = !$scope.showXunleiHelp;
    }

    $scope.toggleShowConnectionHelp = function() {
      $translate('CONNECTION_HELP')
        .then(function (translatedVal) {
          $rootScope.connectionHelpText = translatedVal;
        });

      $scope.showConnectionHelp = !$scope.showConnectionHelp;
    }
}]);

'use strict';

var directives = angular.module('app.directives', [])
  .directive('compileUnsafe', function ($compile) {
    return function (scope, element, attr) {
      scope.$watch(attr.compileUnsafe, function (val, oldVal) {
        if (!val || (val === oldVal && element[0].innerHTML)) return;
        element.html(val);
        $compile(element)(scope);
      });
    };
  })
  .directive('focusOn', function ($parse) {
    return function(scope, element, attr) {
      var val = $parse(attr['focusOn']);
      scope.$watch(val, function (val) {
        if (val) {
          element.focus();
        }
      });
    }
  })
  .directive('onError', function ($parse) {
    return {
      link: function(scope, element, attrs) {
        element.bind('error', function() {
          scope.$apply(attrs.onError);
        });
      }
    };
  });

// XXX https://github.com/angular/angular.js/issues/1050#issuecomment-9650293
angular.forEach(['x', 'y', 'cx', 'cy', 'd', 'fill', 'r'], function(name) {
  var ngName = 'ng' + name[0].toUpperCase() + name.slice(1);
  directives.directive(ngName, function() {
    return function(scope, element, attrs) {
      attrs.$observe(ngName, function(value) {
        attrs.$set(name, value); 
      })
    };
  });
});
