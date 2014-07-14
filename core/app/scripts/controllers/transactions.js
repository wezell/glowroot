/*
 * Copyright 2013-2014 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* global glowroot, angular, $ */

glowroot.controller('TransactionsCtrl', [
  '$scope',
  '$location',
  '$filter',
  '$http',
  '$q',
  '$timeout',
  '$modal',
  'queryStrings',
  'httpErrors',
  function ($scope, $location, $filter, $http, $q, $timeout, $modal, queryStrings, httpErrors) {
    // \u00b7 is &middot;
    document.title = 'Transactions \u00b7 Glowroot';
    $scope.$parent.title = 'Transactions';
    $scope.$parent.activeNavbarItem = 'transactions';

    var plot;
    // plotTransactionName is only updated when the plot is updated
    var plotTransactionName;

    var fixedTransactionPointIntervalMillis = $scope.layout.fixedTransactionPointIntervalSeconds * 1000;

    var currentRefreshId = 0;
    var currentZoomId = 0;

    var $chart = $('#chart');

    // top 25 is a nice number, screen is not too large
    var transactionLimit = 25;

    // this is used to calculate bar width under transaction name representing the proportion of total time
    var maxTransactionTotalMicros;

    $scope.$watchCollection('[containerWidth, windowHeight]', function () {
      plot.resize();
      plot.setupGrid();
      plot.draw();
    });

    $scope.showChartSpinner = 0;

    function refreshChart(refreshButtonDeferred, skipUpdateTransactions) {
      var date = $scope.filterDate;
      var refreshId = ++currentRefreshId;
      var query = {
        from: $scope.chartFrom,
        to: $scope.chartTo,
        transactionType: $scope.filterTransactionType
      };
      if ($scope.selectedTransactionName) {
        query.transactionName = $scope.selectedTransactionName;
      }
      var pointsDeferred;
      if (refreshButtonDeferred && !skipUpdateTransactions) {
        pointsDeferred = $q.defer();
      } else {
        // TODO this conditional won't be needed once the transaction page displays trace metric stacked chart and
        // skipUpdateTransactions is not needed
        pointsDeferred = refreshButtonDeferred;
      }
      $scope.showChartSpinner++;
      $http.get('backend/transaction/stacked?' + queryStrings.encodeObject(query))
          .success(function (data) {
            $scope.showChartSpinner--;
            if (refreshId !== currentRefreshId) {
              return;
            }
            $scope.refreshChartError = false;
            // reset axis in case user changed the date and then zoomed in/out to trigger this refresh
            plot.getAxes().xaxis.options.min = query.from;
            plot.getAxes().xaxis.options.max = query.to;
            plot.getAxes().xaxis.options.zoomRange = [
              date.getTime(),
                  date.getTime() + 24 * 60 * 60 * 1000
            ];
            plotTransactionName = query.transactionName;
            var plotData = [];
            angular.forEach(data, function (dataSeries) {
              plotData.push({
                data: dataSeries.data,
                label: dataSeries.name ? dataSeries.name : 'Other'
              });
            });
            plot.setData(plotData);
            plot.setupGrid();
            plot.draw();
            if (pointsDeferred) {
              pointsDeferred.resolve('Success');
            }
          })
          .error(function (data, status) {
            $scope.showChartSpinner--;
            if (refreshId !== currentRefreshId) {
              return;
            }
            $scope.chartLimitExceeded = false;
            if (status === 0) {
              $scope.refreshChartError = 'Unable to connect to server';
            } else {
              $scope.refreshChartError = 'An error occurred';
            }
            if (pointsDeferred) {
              pointsDeferred.reject($scope.refreshChartError);
            }
          });
      if (!skipUpdateTransactions) {
        // TODO this conditional will be always true once the transaction page displays trace metric stacked chart and
        // skipUpdateTransactions is not needed
        var transactionsDeferred;
        if (refreshButtonDeferred) {
          transactionsDeferred = $q.defer();
          $q.all([pointsDeferred.promise, transactionsDeferred.promise])
              .then(function () {
                refreshButtonDeferred.resolve('Success');
              }, function (data) {
                refreshButtonDeferred.resolve(data);
              });
        }
        // give the points request above a small head start since otherwise the transactions query could get handled
        // first, which isn't that bad, but the aggregate query is much slower and the glowroot http handler is
        // throttled to one thread currently
        $timeout(function () {
          updateTransactions(transactionsDeferred);
        }, 5);
      }
    }

    $scope.refreshButtonClick = function (deferred) {
      var midnight = new Date($scope.chartFrom).setHours(0, 0, 0, 0);
      if (midnight !== $scope.filterDate.getTime()) {
        // filterDate has changed
        chartFromToDefault = false;
        $scope.chartFrom = $scope.filterDate.getTime() + ($scope.chartFrom - midnight);
        $scope.chartTo = $scope.filterDate.getTime() + ($scope.chartTo - midnight);
      }
      updateLocation();
      refreshChart(deferred);
    };

    $chart.bind('plotzoom', function (event, plot, args) {
      plot.setupGrid();
      // TODO add spinner
      plot.draw();
      $scope.$apply(function () {
        $scope.chartFrom = plot.getAxes().xaxis.min;
        $scope.chartTo = plot.getAxes().xaxis.max;
        chartFromToDefault = false;
        updateLocation();
      });
      var zoomId = ++currentZoomId;
      // use 100 millisecond delay to handle rapid zooming
      setTimeout(function () {
        if (zoomId !== currentZoomId) {
          return;
        }
        $scope.$apply(function () {
          refreshChart();
        });
      }, 100);
    });

    $chart.bind('plotselected', function (event, ranges) {
      plot.clearSelection();
      // perform the zoom
      plot.getAxes().xaxis.options.min = ranges.xaxis.from;
      plot.getAxes().xaxis.options.max = ranges.xaxis.to;
      plot.setupGrid();
      plot.draw();
      $scope.$apply(function () {
        $scope.chartFrom = plot.getAxes().xaxis.min;
        $scope.chartTo = plot.getAxes().xaxis.max;
        chartFromToDefault = false;
        updateLocation();
      });
      currentRefreshId++;
      $scope.$apply(function () {
        refreshChart();
      });
    });

    var showingItemId;
    $chart.bind('plothover', function (event, pos, item) {
      if (item) {
        var itemId = item.datapoint[0];
        if (itemId !== showingItemId) {
          showChartTooltip(item);
          showingItemId = itemId;
        }
      } else {
        hideTooltip();
      }
    });

    function showChartTooltip(item) {
      var x = item.pageX;
      var y = item.pageY;
      var captureTime = item.datapoint[0];
      var from = $filter('date')(captureTime - fixedTransactionPointIntervalMillis, 'mediumTime');
      var to = $filter('date')(captureTime, 'mediumTime');
      var traceCount = plot.getData()[item.seriesIndex].data[item.dataIndex][2];
      var average;
      if (traceCount === 0) {
        average = '--';
      } else {
        average = item.datapoint[1].toFixed(2);
      }
      if (traceCount === 1) {
        traceCount = traceCount + ' trace';
      } else {
        traceCount = traceCount + ' traces';
      }
      var text = '';
      if (plotTransactionName) {
        text += '<strong>' + plotTransactionName + '</strong><br>';
      } else {
        text += '<strong>All Transactions</strong><br>';
      }
      text += '<span class="transaction-tooltip-label">From:</span>' + from + '<br>' +
          '<span class="transaction-tooltip-label">To:</span>' + to + '<br>' +
          '<span class="transaction-tooltip-label">Average:</span>' + average + ' seconds<br>' +
          '<span class="transaction-tooltip-label"></span>(' + traceCount + ')';
      var $chartContainer = $('.chart-container');
      var chartOffset = $chartContainer.offset();
      var target = [ x - chartOffset.left + 1, y - chartOffset.top ];
      $chart.qtip({
        content: {
          text: text
        },
        position: {
          my: 'bottom center',
          target: target,
          adjust: {
            y: -5
          },
          viewport: $(window),
          // container is the dom node where qtip div is attached
          // this needs to be inside the angular template so that its lifecycle is tied to the angular template
          container: $chartContainer
        },
        style: {
          classes: 'ui-tooltip-bootstrap qtip-override-transaction qtip-border-color-0'
        },
        hide: {
          event: false
        },
        show: {
          event: false
        },
        events: {
          hide: function () {
            showingItemId = undefined;
          }
        }
      });
      $chart.qtip('show');
    }

    function hideTooltip() {
      $chart.qtip('hide');
    }

    $chart.mousedown(function () {
      hideTooltip();
    });

    $(document).keyup(function (e) {
      // esc key
      if (e.keyCode === 27 && showingItemId) {
        // the tooltips have hide events that set showingItemId = undefined
        // so showingItemId must be checked before calling hideTooltip()
        hideTooltip();
      }
    });

    $scope.$watch('filterTransactionType', function (newValue, oldValue) {
      if (newValue !== oldValue) {
        $scope.selectedTransactionName = '';
        $timeout(function() {
          $('#refreshButtonSpan').find('button').click();
        }, 0, false);
      }
    });

    $scope.$watch('filterDate', function (newValue, oldValue) {
      if (newValue !== oldValue) {
        $timeout(function() {
          $('#refreshButtonSpan').find('button').click();
        }, 0, false);
      }
    });

    $scope.viewTransactionDetail = function (deferred) {
      // calling resolve immediately is needed to suppress the spinner since this is part of a gt-button-group
      deferred.resolve();
      var transactionQuery = {
        from: $scope.chartFrom,
        to: $scope.chartTo,
        transactionType: $scope.filterTransactionType
      };
      if ($scope.selectedTransactionName) {
        transactionQuery.transactionName = $scope.selectedTransactionName;
      }
      $modal.open({
        templateUrl: 'views/transaction-detail.html',
        controller: 'TransactionDetailCtrl',
        windowClass: 'full-screen-modal',
        resolve: {
          transactionQuery: function () {
            return transactionQuery;
          }
        }
      });
    };

    $scope.showTableOverlay = 0;
    $scope.showTableSpinner = 0;

    function updateTransactions(deferred) {
      var query = {
        from: $scope.chartFrom,
        to: $scope.chartTo,
        transactionType: $scope.filterTransactionType,
        sortAttribute: $scope.sortAttribute,
        sortDirection: $scope.sortDirection,
        limit: transactionLimit
      };
      $scope.showTableOverlay++;
      if (!deferred) {
        // show table spinner if not triggered from refresh button or show more button
        $scope.showTableSpinner++;
      }
      $http.get('backend/transaction/summaries?' + queryStrings.encodeObject(query))
          .success(function (data) {
            $scope.showTableOverlay--;
            if (!deferred) {
              $scope.showTableSpinner--;
            }
            $scope.overall = data.overall;
            $scope.moreAvailable = data.moreAvailable;
            $scope.transactions = data.transactions;
            maxTransactionTotalMicros = 0;
            angular.forEach($scope.transactions, function (transaction) {
              maxTransactionTotalMicros =
                  Math.max(maxTransactionTotalMicros, transaction.totalMicros);
            });
            if (deferred) {
              deferred.resolve();
            }
          })
          .error(httpErrors.handler($scope, deferred));
    }

    $scope.overallAverage = function () {
      if (!$scope.overall) {
        // overall hasn't loaded yet
        return '';
      } else if ($scope.overall.count) {
        return (($scope.overall.totalMicros / $scope.overall.count) / 1000000).toFixed(2);
      } else {
        return '-';
      }
    };

    $scope.sort = function (attributeName) {
      if ($scope.sortAttribute === attributeName) {
        // switch direction
        if ($scope.sortDirection === 'desc') {
          $scope.sortDirection = 'asc';
        } else {
          $scope.sortDirection = 'desc';
        }
      } else {
        $scope.sortAttribute = attributeName;
        $scope.sortDirection = 'desc';
      }
      updateLocation();
      updateTransactions();
    };

    $scope.sortIconClass = function (attributeName) {
      if ($scope.sortAttribute !== attributeName) {
        return '';
      }
      if ($scope.sortDirection === 'desc') {
        return 'caret';
      } else {
        return 'caret transaction-caret-reversed';
      }
    };

    $scope.tracesQueryString = function (transactionName) {
      var query = {
        // from is adjusted because transaction points are aggregates of the interval before the transaction point
        from: $scope.chartFrom - fixedTransactionPointIntervalMillis,
        to: $scope.chartTo,
        transactionType: $scope.filterTransactionType
      };
      if (transactionName) {
        query.transactionName = transactionName;
        query.transactionNameComparator = 'equals';
      }
      return queryStrings.encodeObject(query);
    };

    $scope.showMore = function (deferred) {
      // double each time
      transactionLimit *= 2;
      updateTransactions(deferred);
    };

    $scope.updateFilterLimit = function (limit) {
      $scope.updatingFilterLimit = true;
      var deferred = $q.defer();
      deferred.promise.then(function () {
        $scope.updatingFilterLimit = false;
      }, function (error) {
        // TODO handle error
        $scope.updatingFilterLimit = false;
      });
    };

    $scope.clickTransactionName = function (transactionName) {
      $scope.selectedTransactionName = transactionName;
      updateLocation();
      refreshChart(undefined, true);
    };

    $scope.transactionBarWidth = function (totalMicros) {
      return (totalMicros / maxTransactionTotalMicros) * 100 + '%';
    };

    $('#zoomOut').click(function () {
      plot.zoomOut();
    });

    var chartFromToDefault;

    $scope.filter = {};
    $scope.chartFrom = Number($location.search().from);
    $scope.chartTo = Number($location.search().to);
    // both from and to must be supplied or neither will take effect
    if ($scope.chartFrom && $scope.chartTo) {
      $scope.chartFrom += fixedTransactionPointIntervalMillis;
      $scope.filterDate = new Date($scope.chartFrom);
      $scope.filterDate.setHours(0, 0, 0, 0);
    } else {
      chartFromToDefault = true;
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      $scope.filterDate = today;
      // show 2 hour interval, but nothing prior to today (e.g. if 'now' is 1am) or after today
      // (e.g. if 'now' is 11:55pm)
      var now = new Date();
      now.setSeconds(0, 0);
      var fixedTransactionPointIntervalMinutes = fixedTransactionPointIntervalMillis / (60 * 1000);
      if (fixedTransactionPointIntervalMinutes > 1) {
        // this is the normal case since default transaction point interval is 5 min
        var minutesRoundedDownToNearestAggregationInterval =
            fixedTransactionPointIntervalMinutes * Math.floor(now.getMinutes() / fixedTransactionPointIntervalMinutes);
        now.setMinutes(minutesRoundedDownToNearestAggregationInterval);
      }
      $scope.chartFrom = Math.max(now.getTime() - 105 * 60 * 1000, today.getTime());
      $scope.chartTo = Math.min($scope.chartFrom + 120 * 60 * 1000, today.getTime() + 24 * 60 * 60 * 1000);
    }
    $scope.filterTransactionType = $location.search()['transaction-type'] || $scope.layout.defaultTransactionType;
    $scope.sortAttribute = $location.search()['sort-attribute'] || 'total';
    $scope.sortDirection = $location.search()['sort-direction'] || 'desc';

    $scope.selectedTransactionName = $location.search()['transaction-name'];

    function updateLocation() {
      var query = {};
      if (!chartFromToDefault) {
        query.from = $scope.chartFrom - fixedTransactionPointIntervalMillis;
        query.to = $scope.chartTo;
      }
      if ($scope.filterTransactionType !== $scope.layout.defaultTransactionType) {
        query['transaction-type'] = $scope.filterTransactionType;
      }
      if ($scope.selectedTransactionName) {
        query['transaction-name'] = $scope.selectedTransactionName;
      }
      if ($scope.sortAttribute !== 'total' || $scope.sortDirection !== 'desc') {
        query['sort-attribute'] = $scope.sortAttribute;
        if ($scope.sortDirection !== 'desc') {
          query['sort-direction'] = $scope.sortDirection;
        }
      }
      $location.search(query).replace();
    }

    (function () {
      var options = {
        grid: {
          hoverable: true,
          mouseActiveRadius: 10,
          // min border margin should match trace chart so they are positioned the same from the top of page
          // without specifying min border margin, the point radius is used
          minBorderMargin: 10,
          borderColor: '#7d7358',
          borderWidth: 1
        },
        xaxis: {
          mode: 'time',
          timezone: 'browser',
          twelveHourClock: true,
          ticks: 5,
          min: $scope.chartFrom,
          max: $scope.chartTo,
          absoluteZoomRange: true,
          zoomRange: [
            $scope.filterDate.getTime(),
                $scope.filterDate.getTime() + 24 * 60 * 60 * 1000
          ]
        },
        yaxis: {
          ticks: 10,
          zoomRange: false,
          min: 0,
          // 10 second yaxis max just for initial empty chart rendering
          max: 10,
          label: 'seconds'
        },
        zoom: {
          interactive: true,
          amount: 2,
          skipDraw: true
        },
        selection: {
          mode: 'x'
        },
        series: {
          stack: true,
          lines: {
            show: true,
            fill: true
          }
        }
      };
      // render chart with no data points
      plot = $.plot($chart, [], options);
      plot.getAxes().xaxis.options.borderGridLock = fixedTransactionPointIntervalMillis;
    })();

    plot.getAxes().yaxis.options.max = undefined;
    refreshChart();
  }
]);
