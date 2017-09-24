import angular from 'angular';
import chrome from 'ui/chrome';
import uiRoutes from 'ui/routes';
import { notify } from 'ui/notify';
import { uiModules } from "ui/modules";
import sugarDate from 'sugar-date';
import moment from 'moment-timezone';

import 'ui/autoload/styles';
import 'plugins/logtrail/css/main.css';
import 'plugins/logtrail/directives/format_event.js';

import template from './templates/index.html';

const app = uiModules.get('app/logtrail', []);

uiRoutes.enable();
uiRoutes
.when('/', {
  template: template,
  reloadOnSearch: false
});

document.title = 'LogTrail - Kibana';

app.controller('logtrail', function ($scope, kbnUrl, $route, $routeParams,
   $window, $interval, $http, $document, $timeout, $location, $sce) {
  $scope.title = 'LogTrail';
  $scope.description = 'Plugin to view, search & tail logs in Kibana';
  $scope.userSearchText = null;
  $scope.events = [];
  $scope.userDateTime = null; // exact string typed by user like 'Aug 24 or last friday'
  $scope.pickedDateTime = null; // UTC date used in search query.
  $scope.userDateTimeSeeked = null; // exact string entered by user set after user clicks seek. Used to show in search button
  $scope.liveTailStatus = 'Live';
  $scope.hosts = null;
  $scope.selectedHost = null;
  $scope.firstEventReached = false;
  $scope.errorMessage = null;
  $scope.noEventErrorStartTime = null;
  $scope.showNoEventsMessage = false;
  $scope.index_patterns = [];
  $scope.selected_index_pattern = null;
  $scope.popup = null;
  $scope.argPopup = {
    style : {
    }
  };

  $scope.msgPopup = {
    plusIcon : true,
    style : {

    }
  }
  var updateViewInProgress = false;
  var tailTimer = null;
  var searchText = null;
  var lastEventTime = null;
  var config,selected_index_config = null;
  //Backup for event, with only event Ids as keys
  var eventIds = new Set();

  function init() {
    //init scope vars from get params if available
    if ($routeParams.q) {
      $scope.userSearchText = $routeParams.q === '*' ? null : $routeParams.q;
      searchText = $routeParams.q;
    }

    if ($routeParams.h) {
      $scope.selectedHost = $routeParams.h === 'All' ? null : $routeParams.h;
    }

    if ($routeParams.t) {
      if ($routeParams.t === 'Now' || $routeParams.t == null) {
        $scope.pickedDateTime = null;
        $scope.userDateTime = null;
      } else {
        $scope.pickedDateTime = convertStringToDate($routeParams.t);
        $scope.userDateTimeSeeked = $routeParams.t;
      }
    }
    $http.get(chrome.addBasePath('/logtrail/config')).then(function (resp) {
      if (resp.data.ok) {
        config = resp.data.config;
      }

      //populate index_patterns
      for (var i = config.index_patterns.length - 1; i >= 0; i--) {          
        $scope.index_patterns.push(config.index_patterns[i].es.default_index);          
      }
      if($routeParams.i) {
        for (var i = config.index_patterns.length - 1; i >= 0; i--) {
          if (config.index_patterns[i].es.default_index === $routeParams.i) {
            selected_index_config = config.index_patterns[i];
            break;
          }
        }
      }
      if (selected_index_config === null) {
        selected_index_config = config.index_patterns[0];
      }
      $scope.selected_index_pattern = selected_index_config.es.default_index;
      checkElasticsearch();
    });        
  };
  
  function checkElasticsearch() {
    var params = {
      index: selected_index_config.es.default_index
    };
    return $http.post(chrome.addBasePath('/logtrail/validate/es'), params).then(function (resp) {
      if (resp.data.ok) {        
        console.info('connection to elasticsearch successful');
        //Initialize app views on validate successful
        setupHostsList();
        if ($scope.pickedDateTime == null) {
          doSearch(null, 'desc', ['overwrite','reverse'], null);
        } else {
          var timestamp = Date.create($scope.pickedDateTime).getTime();
          doSearch('gt','asc', ['overwrite','scrollToTop'],timestamp);
        }
        startTailTimer();
      } else {
        console.error('validate elasticsearch failed :' , resp);
        if (resp.data.resp.message) {
          $scope.errorMessage = resp.data.resp.message;
        } else {
          $scope.errorMessage = 'ES Validation failed : ' + resp.data.resp;
        }
      }
    });
  };

  /**
  rangeType - gte or lte
  action - whether to append new events to end or prepend or clear all events (overwrite)
  timestamp - timestamp for range if available
  **/
  function doSearch(rangeType,order,actions,timestamp) {

    var request = {
      searchText: searchText,
      timestamp: timestamp,
      rangeType: rangeType,
      order: order,
      hostname: $scope.selectedHost,
      index: selected_index_config.es.default_index
    };

    console.debug("sending search request with params " + JSON.stringify(request));
    return $http.post(chrome.addBasePath('/logtrail/search'), request).then(function (resp) {
      if (resp.data.ok) {
        updateEventView(resp.data.resp,actions,order);
      } else {
        console.error('Error while fetching events ' , resp);
        $scope.errorMessage = 'Exception while executing search query :' + resp.data.resp.msg;
      }
    });
  };

  function removeDuplicates(newEventsFromServer) {
    var BreakException = {};
    for (var i = newEventsFromServer.length - 1; i >= 0; i--) {
      var newEvent = newEventsFromServer[i];
      if (eventIds.has(newEvent.id)) {
        newEventsFromServer.splice(i,1);
      }
    }
  }

  //formats event based on logtrail.json config
  function formatEvent(event) {
    // display_timestamp based on configured timezone and format
    if (selected_index_config.display_timestamp_format != null) {
      var display_timestamp = moment(event['display_timestamp']);
      if (selected_index_config.display_timezone !== 'local') {
        display_timestamp = display_timestamp.tz(selected_index_config.display_timezone);
      }
      event['display_timestamp'] = display_timestamp.format(selected_index_config.display_timestamp_format);
    }

    //message format
    if (selected_index_config.fields.message_format) {
      event['message'] = $sce.trustAsHtml(event['message']);
    }
  }

  /*
  actions available
  overwrite -
  append -
  prepend -
  reverse -
  scrollToTop -
  scrollToView - in case of prepend,i.e scrollUp that old event should be visible
  scrollToBottom - Default behavior, no need to pass
  startTimer - start tail timer. Will be invoked duing initialization
  */

  function updateEventView(events,actions,order) {

    updateViewInProgress = true;
    $scope.showNoEventsMessage = false;

    // Add parsed timestamp to all events
    for (var i = events.length - 1; i >= 0; i--) {
      formatEvent(events[i]);
    }

    if (actions.indexOf('reverse') !== -1) {
      events.reverse();
    }
    if (actions.indexOf('overwrite') !== -1) {
      $scope.firstEventReached = false;
      $scope.events = [];
      eventIds.clear();
      angular.forEach(events, function (event) {
        $scope.events.push(event);
        eventIds.add(event.id);
      });
      $timeout(function () {
        //If scrollbar not visible
        if (angular.element($document).height() <= angular.element($window).height()) {
          $scope.firstEventReached = true;
        }
      });
    }
    if (actions.indexOf('append') !== -1) {
      //If events are order desc, the reverse the list
      if (order === 'desc') {
        events.reverse();
      }
      removeDuplicates(events);
      angular.forEach(events, function (event) {
        $scope.events.push(event);
        eventIds.add(event.id);
      });
    }
    var firstEventId = null;
    if (actions.indexOf('prepend') !== -1) {
      removeDuplicates(events);
      if (events.length > 0) {
        //Need to move scrollbar to old event location,
        //so note down its id of before model update
        firstEventId = $scope.events[0].id;
        angular.forEach(events, function (event) {
          $scope.events.unshift(event);
          eventIds.add(event.id);
        });
      } else {
        $scope.firstEventReached = true;
      }
    }

    if (actions.indexOf('scrollToTop') !== -1) {
      $timeout(function () {
        window.scrollTo(0,5);
      });
    } else if (actions.indexOf('scrollToView') !== -1) {

      if (firstEventId !== null) {
        //Make sure the old top event in is still in view
        $timeout(function () {
          var firstEventElement = document.getElementById(firstEventId);
          if (firstEventElement !== null) {
            var topPos = firstEventElement.offsetTop;
            firstEventElement.scrollIntoView();
          }
        });
      }
    } else {
      //Bring scroll to bottom
      $timeout(function () {
        window.scrollTo(0,$(document).height());
      });
    }

    trimEvents(actions.indexOf('append') != -1);

    if ($scope.events.length > 0) {
      lastEventTime = Date.create($scope.events[$scope.events.length - 1].timestamp).getTime();
    } else {
      lastEventTime = null;
    }

    $timeout(function () {
      updateViewInProgress = false;
    });

    if ($scope.events != null && $scope.events.length === 0) {
      $scope.showNoEventsMessage = true;
      if ($scope.pickedDateTime != null) {
        var timestamp = Date.create($scope.pickedDateTime).getTime();
        $scope.noEventErrorStartTime = moment(timestamp).format('MMMM Do YYYY, h:mm:ss a');
      } else {
        if (selected_index_config.default_time_range_in_days !== 0) {
          $scope.noEventErrorStartTime = moment().subtract(
            selected_index_config.default_time_range_in_days,'days').startOf('day').format('MMMM Do YYYY, h:mm:ss a');
        }
      }
    }
  };

  function trimEvents(append) {
    var eventCount = $scope.events.length;
    if (eventCount > selected_index_config.max_events_to_keep_in_viewer) {
        var noOfItemsToDelete = eventCount - selected_index_config.max_events_to_keep_in_viewer;
        //if append the remove from top
        var removedEvents = [];
        if (append) {
          removedEvents = $scope.events.splice(0,noOfItemsToDelete);
        } else { //remove from bottom
          removedEvents = $scope.events.splice(-noOfItemsToDelete);
        }

        //delete the removed event ids from cache.
        for (var i = 0; i < removedEvents.length; i++) {
          eventIds.delete(removedEvents[i].id);
        }
    }
  }

  $scope.isTimeRangeSearch = function () {
    return (selected_index_config != null && selected_index_config.default_time_range_in_days !== 0) || $scope.pickedDateTime != null;
  };

  $scope.onSearchClick = function () {
    searchText = '*';
    if ($scope.userSearchText != null) {
      searchText = $scope.userSearchText;
    }

    var host = $scope.selectedHost;
    if (host == null) {
      host = 'All';
    }

    var time = $scope.userDateTimeSeeked;
    if (time == null) {
      time = 'Now';
    }

    $location.path('/').search({q: searchText, h: host, t:time, i:selected_index_config.es.default_index});

    if ($scope.pickedDateTime != null) {
      var timestamp = Date.create($scope.pickedDateTime).getTime();
      doSearch('gt','asc', ['overwrite','scrollToTop'],timestamp);
    } else {
      doSearch(null,'desc', ['overwrite','reverse'],null);
    }
  };

  $scope.resetDatePicker = function () {    
    if ($scope.pickedDateTime == null) {
      $scope.userDateTime = null;
    }
  };

  $scope.onDateChange = function () {
    $scope.pickedDateTime = convertStringToDate($scope.userDateTime);
  };

  function convertStringToDate(string) {
    var date = null;
    var retDate = null;
    if (string !== '') {
      date = Date.create(string);
    }
    if (date !== null && date.isValid()) {
      retDate = date.full();
    } else {
      retDate = null;
    }
    return retDate;
  }

  $scope.seekAndSearch = function () {
    if ($scope.pickedDateTime != null) {
      $scope.userDateTimeSeeked = $scope.userDateTime;
    } else {
      $scope.userDateTimeSeeked = null;
    }
    angular.element('#date-picker').addClass('ng-hide');
    $scope.onSearchClick();
  };

  $scope.onSettingsChange = function () {
    if ($scope.selected_index_pattern !== selected_index_config.es.default_index) {
      for (var i = config.index_patterns.length - 1; i >= 0; i--) {
        if (config.index_patterns[i].es.default_index === $scope.selected_index_pattern) {
          selected_index_config = config.index_patterns[i];
          break;
        }
      }
    }
    angular.element('#settings').addClass('ng-hide');
    //reset index specific states. 
    // Other fields will be overwritten on successful search
    $scope.events = [];
    eventIds.clear();
    $scope.selectedHost = null; //all systems
    $scope.hosts = null;
    $scope.errorMessage = null;

    setupHostsList();
    $scope.onSearchClick();
  };

  $scope.isNullorEmpty = function (string) {
    return string == null || string === '';
  };

  $scope.toggleLiveTail = function () {
    if ($scope.liveTailStatus === 'Live') {
      updateLiveTailStatus('Pause');
    } else if ($scope.liveTailStatus === 'Pause') {
      updateLiveTailStatus('Live');
      doTail();
    } else { //Go Live - refresh whole view to launch view
      $scope.pickedDateTime = null;
      $scope.userDateTime = null;
      $scope.userDateTimeSeeked = null;
      updateLiveTailStatus('Live');
      doSearch(null, 'desc', ['overwrite','reverse'], null);
    }
  };

  $scope.onHostSelected = function (host) {
    angular.element('#host-picker').addClass('ng-hide');
    if (host === '*') {
      $scope.selectedHost = null;
    } else {
      $scope.selectedHost = host;
    }
    $scope.onSearchClick();
  };

  $scope.onProgramClick = function (program) {
    var programField = selected_index_config.fields.mapping['program'];
    if (selected_index_config.es.default_index.startsWith('logstash-')) {
      programField += ".keyword";
    }
    $scope.userSearchText =  programField  + ':"' + program + '"';
    $scope.onSearchClick();
  };

  $scope.onClick = function (name,value) {
    $scope.search(name + ': "' + value + '"');
  };

  //TODO :: What if there is already a string string present???
  $scope.search = function (searchString) {
    $scope.userSearchText = searchString;
    $scope.onSearchClick();
  }

  $scope.getLiveTailStatus = function () {
    if ($scope.liveTailStatus === 'Live') {
      return 'PAUSE';
    } else if ($scope.liveTailStatus === 'Pause') {
      return 'LIVE';
    } else {
      return 'GO LIVE';
    }
  };

  $scope.closeArgPopup = function (argument) {
    if ($scope.argPopup.argElement) {
      $scope.argPopup.argElement.removeClass("highlight-arg");
    }
    $scope.argPopup.show = false;
    $scope.argPopup.event = null;
  }

  $scope.showMsgPopup = function (clickEvent, event) {
    var rect = clickEvent.target.getBoundingClientRect();
    $scope.msgPopup.style.left = rect.left - 30;
    $scope.msgPopup.style.top = rect.top + 50;
    $scope.msgPopup.event = event;
    $scope.msgPopup.show = true;
  }

  $scope.closeMsgPopup = function () {
    $scope.msgPopup.show = false;
    $scope.msgPopup.event = null;
  }

  $scope.getEventNgClass = function (event) {
    var highlightClass = null;
    if ($scope.msgPopup.event) {
      if ($scope.msgPopup.event.id == event.id && $scope.msgPopup.show) {
          highlightClass = 'highlight-event';
      } else if ($scope.msgPopup.event.id == event.id) {
        if ($scope.msgPopup.plusIcon) {
          highlightClass = 'highlight-event';
        }
      }
    }

    if ($scope.argPopup.event) {
      if (event.id === $scope.argPopup.event.id) {
        highlightClass = 'highlight-event';
      }
    }

    return highlightClass;
  }

  $scope.onEventMouseOver = function (event) {
    if (!$scope.msgPopup.show) {
      $scope.msgPopup.plusIcon = true;
      $scope.msgPopup.event = event;
    }
  }

  $scope.onEventMouseLeave = function (event) {
    if (event.id != $scope.msgPopup.event.id) {
      $scope.msgPopup.plusIcon = false;
    }
  }

  $scope.showExactMatches = function () {
    var event = $scope.msgPopup.event;
    $scope.closeMsgPopup();
    $scope.search('"' + event.raw_message + '"');
  }

  $scope.showSimilarMessages = function () {
    var event = $scope.msgPopup.event;
    $scope.closeMsgPopup();
    $scope.search('logtrail.patternId : ' + event.patternInfo.patternId);
  }

  $scope.showMessagesContaining = function () {
    var text = $scope.argPopup.text;
    $scope.closeArgPopup();
    $scope.search('"' + text + '"');
  }

  $scope.showSimilarMessagesContaining = function () {
    var text = $scope.argPopup.text;
    var argNum = $scope.argPopup.argNum;
    var patternInfo = $scope.argPopup.event.patternInfo;
    var searchString = 'logtrail.patternId:' + patternInfo.patternId + ' AND logtrail.a' + argNum + ':"' + text + '"';
    $scope.closeArgPopup();
    $scope.search(searchString);
  }

  angular.element($window).bind('scroll', function (event) {

    if (!updateViewInProgress) {
      //When scroll bar reaches bottom
      var scrollTop = angular.element($window).scrollTop();
      var scrollPos = angular.element($window).scrollTop() + angular.element($window).height();
      var docHeight = angular.element($document).height();
      if (scrollPos >= docHeight) {
        if ($scope.events.length > 0) {
          doSearch('gte', 'asc', ['append','scrollToView'], lastEventTime - ( selected_index_config.es_index_time_offset_in_seconds * 1000 ));
        }
        $scope.$apply(updateLiveTailStatus('Live'));
      } else {
        //When scroll bar is in middle
        $scope.$apply(updateLiveTailStatus('Go Live'));
      }

      //When scrollbar reaches top & if scroll bar is visible
      if (window.pageYOffset === 0) {
        // && angular.element($document).height() > angular.element($window).height()) {
        if ($scope.events.length > 0) {
          var timestamp = Date.create($scope.events[0].timestamp).getTime();
          doSearch('lte', 'desc', ['prepend','scrollToView'], timestamp);
        }
      }
    }
  });

  function updateLiveTailStatus(status) {
    $scope.liveTailStatus = status;
  };

  function doTail() {
    if ($scope.liveTailStatus === 'Live' && !updateViewInProgress) {

      var adjustedLastEventTime = null;
      if (lastEventTime) {
        adjustedLastEventTime = lastEventTime - ( selected_index_config.es_index_time_offset_in_seconds * 1000 );
      }
      doSearch('gte', 'asc', ['append'], adjustedLastEventTime);
    }
  };

  function startTailTimer() {
    if (config != null) {
      tailTimer = $interval(doTail,(selected_index_config.tail_interval_in_seconds * 1000));
      $scope.$on('$destroy', function () {
        stopTailTimer();
      });
    }
  };

  function stopTailTimer() {
    if (tailTimer) {
      $interval.cancel(tailTimer);
    }
  };

  function setupHostsList() {
    var params = {
      index: selected_index_config.es.default_index
    };
    $http.post(chrome.addBasePath('/logtrail/hosts'),params).then(function (resp) {
      if (resp.data.ok) {
        $scope.hosts = [];
        for (var i = resp.data.resp.length - 1; i >= 0; i--) {
          $scope.hosts.push(resp.data.resp[i].key);
        }
        $scope.hosts.sort();
      } else {
        console.error('Error while fetching hosts : ' , resp.data.resp.msg);
        $scope.errorMessage = 'Exception while fetching hosts : ' + resp.data.resp.msg;
      }
    });
  }

  init();
});

//Directive to manage scroll during launch and on new events
uiModules.get('app/logtrail').directive('onLastRepeat', function () {
  return function (scope, element, attrs) {
    if (scope.$last) {
      setTimeout(function () {
        scope.$emit('onRepeatLast', element, attrs);
      }, 1);
    }
  };
});

uiModules.get('app/logtrail').directive('clickOutside', function ($document) {
  return {
    restrict: 'A',
    scope: false,
    link: function (scope, el, attr) {
      $document.on('click', function (e) {
        if (scope.popup == null || 
            (scope.popup !== e.target && !scope.popup[0].contains(e.target))) {
            if (scope.popup != null) {
              scope.popup.addClass('ng-hide');
            }
            if (e.target.id === 'date-picker-btn' ||
                e.target.id === 'host-picker-btn' ||
                e.target.id === 'settings-btn') {
              scope.popup = angular.element('#' + e.target.id.replace('-btn','')).removeClass('ng-hide');
            }
        }
      });
    }
  };
});

//This is required for onClick event in custom message formats
uiModules.get('app/logtrail').directive('compileTemplate', function($compile, $parse) {
  return {
    link: function(scope, element, attr){
      var parsed = $parse(attr.ngBindHtml);
      function getStringValue() { return (parsed(scope) || '').toString(); }

      //Recompile if the template changes
      scope.$watch(getStringValue, function() {
        $compile(element, null, -9999)(scope);  //The -9999 makes it skip directives so that we do not recompile ourselves
      });
    }
  }
});