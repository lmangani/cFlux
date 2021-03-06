/*
 * ClickFlux DB
 * InfluxDB to Clickhouse Gateway
 * (C) 2018-2019 QXIP BV
 * Some Rights Reserved.
 */

var debug = process.env.DEBUG || false;
var exception = process.env.EXCEPTION || false;
var tsDivide = process.env.TSDIVIDE || 1000000000;

/* DB Helper */
const ifqlparser = require('ifql-parser')();
const lineParser = require('./lineparser');
const ClickHouse = require('@apla/clickhouse');

const clickhouse_options = {
    host: process.env.CLICKHOUSE_SERVER || 'localhost',
    port: process.env.CLICKHOUSE_PORT || 8123,
    queryOptions: { database: process.env.CLICKHOUSE_DB || 'default' }
};
var clickhouse = new ClickHouse(clickhouse_options);
var ch = new ClickHouse(clickhouse_options);

/* Response Helpers */
var resp_empty = {"results":[{"statement_id":0}]};
const toTime = require('to-time');
String.prototype.replaceAll = function(search, replacement) {
    var target = this;
    return target.split(search).join(replacement);
};
var formatDate = function(d){
	return d.getFullYear().toString()+"-"+((d.getMonth()+1).toString().length==2?(d.getMonth()+1).toString():"0"+(d.getMonth()+1).toString())+"-"+(d.getDate().toString().length==2?d.getDate().toString():"0"+d.getDate().toString())+" "+(d.getHours().toString().length==2?d.getHours().toString():"0"+d.getHours().toString())+":"+((parseInt(d.getMinutes()/5)*5).toString().length==2?(parseInt(d.getMinutes()/5)*5).toString():"0"+(parseInt(d.getMinutes()/5)*5).toString())+":00";
};

/* Cache Helper */
var recordCache = require('record-cache');
var onStale = function(data){
 	for (let [key, value] of data.records.entries()) {
	     var statement = "INSERT INTO "+key+"(fingerprint, timestamp_ms, value, string, message)";
   	     ch = new ClickHouse(clickhouse_options);
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR METRIC BULK',err);
	       if (debug) console.log ('Insert Samples complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}
var onStale_string = function(data){
 	for (let [key, value] of data.records.entries()) {
	     var statement = "INSERT INTO "+key+"(fingerprint, timestamp_ms, string, message)";
   	     ch = new ClickHouse(clickhouse_options);
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR METRIC STRING BULK',err);
	       if (debug) console.log ('Insert String Samples complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}
var onStale_float = function(data){
 	for (let [key, value] of data.records.entries()) {
	     var statement = "INSERT INTO "+key+"(fingerprint, timestamp_ms, value, string)";
   	     ch = new ClickHouse(clickhouse_options);
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR METRIC FLOAT BULK',err);
	       if (debug) console.log ('Insert Float Samples complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}

var onStale_labels = function(data){
 	for (let [key, value] of data.records.entries()) {
		// measurement = table, name = metric name
	     var statement = "INSERT INTO time_series(date, fingerprint, measurement, name, labelname, labelvalue, labels)";
   	     ch = new ClickHouse(clickhouse_options);
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR LABEL BULK',err);
	       if (debug) console.log ('Insert Labels complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}

// Subscriptions
var subscriptions = {};
var subscriptions_cache = recordCache({
  maxSize: 100,
  maxAge: 0,
  onStale: false
})
// Per Type-Bulk Pipelines
var bulk_float = recordCache({
  maxSize: 5000,
  maxAge: 2000,
  onStale: onStale_float
})
var bulk_string = recordCache({
  maxSize: 5000,
  maxAge: 2000,
  onStale: onStale_string
})
// Label Bulk Pipeline
var bulk_labels = recordCache({
  maxSize: 100,
  maxAge: 500,
  onStale: onStale_labels
})
// In-Memory LRU for quick lookups
var labels = recordCache({
  maxSize: 50000,
  maxAge: 0,
  onStale: false
})

/* Fingerprinting */
var shortHash = require("short-hash")
var fingerPrint = function(text,hex){
	if (hex) return shortHash(text);
	else return parseInt(shortHash(text), 16);
}

/* Function Helpers */
var labelParser = function(labels){
	// Label Parser
	var rx = /\"?\b(\w+)\"?(!?=~?)("[^"\n]*?")/g;
	var matches, output = [];
	while (matches = rx.exec(labels)) {
	    if(matches.length >3) output.push([matches[1],matches[2],matches[3].replace(/['"]+/g, '')]);
	}
	return output;
}

var databaseName;
var getTableQuery = function(dbName,tableName,string){
	return "CREATE TABLE "+tableName+"( fingerprint UInt64,  timestamp_ms Int64,  value Float64,  string String, message String) ENGINE = MergeTree PARTITION BY toRelativeHourNum(toDateTime(timestamp_ms / 1000)) ORDER BY (fingerprint, timestamp_ms)"
}
var getSeriesTableName = function(tableName){
}
var initializeTimeseries = function(dbName){
	console.log('Initializing TS DB...',dbName);
	var dbQuery = "CREATE DATABASE IF NOT EXISTS "+dbName;
	clickhouse.query(dbQuery, function (err, data) {
		if (err) console.error(err);
		databaseName = dbName;
		clickhouse_options.queryOptions.database = dbName;
		var tmp = new ClickHouse(clickhouse_options);
		var qquery =  "CREATE TABLE "+dbName+".time_series ( date Date,  fingerprint UInt64,  measurement String,  name String,  labelname Array(String),  labelvalue Array(String),  labels String) ENGINE = ReplacingMergeTree PARTITION BY date ORDER BY fingerprint"
	  	tmp.query(qquery, function(err,data){
			if (err) return err;
			if (debug) console.log('TimeSeries Table ready!');
			return true;
		});
	});
}

var databaseCache = [];
var initialize = function(dbName,tableName){
	console.log('Initializing DB...',dbName,tableName);
	if (!dbName||databaseCache.indexOf(dbName) != -1 ) return;
	var dbQuery = "CREATE DATABASE IF NOT EXISTS "+dbName;
	clickhouse.query(dbQuery, function (err, data) {
		if (err) { console.error('ERROR CREATING DATABASE!',dbQuery,err); }
		databaseName = dbName;
		databaseCache.push(dbName);
		if(tableName){
			clickhouse_options.queryOptions.database = dbName;
			var tmp = new ClickHouse(clickhouse_options);
	  		tmp.query(getTableQuery(dbName,tableName), function(err,data){
				if (err) { console.err(getTableQuery(dbName,tableName),err); return; }
				if (debug) console.log('Table ready!',tableName);
				return true;
			});
			reloadFingerprints();
		}
		initializeTimeseries(dbName);
	});
}

// Initialize
// initialize('superloki','samples');

var reloadFingerprints = function(){
  console.log('Reloading Fingerprints...');
  var select_query = "SELECT DISTINCT fingerprint, labels FROM time_series";
  var stream = ch.query(select_query);
  // or collect records yourself
	var rows = [];
	stream.on ('metadata', function (columns) {
	  // do something with column list
	});
	stream.on ('data', function (row) {
	  // TODO: handler error
	  rows.push (row);
	});
	stream.on ('error', function (err) {
	  // TODO: handler error
	});
	stream.on ('end', function () {
	  rows.forEach(function(row){
	    try {
	      var JSON_labels = JSON.parse(row[1])[0];
	      labels.add(row[0],JSON.stringify(JSON_labels));
	  	for (var key in JSON_labels){
			// if (debug) console.log('Adding key',key,row);
			labels.add(key,row[1]);
			labels.add(row[0],1);
	  	};
	    } catch(e) {}
	  });
	  if (debug) console.log('Reloaded fingerprints:',rows.length+1);
	});
}

/* Functions */

/* Function Helpers */
var createTable = function(dbName,tableName){
	if (!tableName||!dbName) return;
	return getTableQuery(dbName,tableName);
};

var tables = [];
var getTables = function(dbName){
	if (!dbName) return;
	var showTables = "show tables";
	clickhouse_options.queryOptions.database = dbName;
  	ch = new ClickHouse(clickhouse_options);
	var stream = clickhouse.query(showTables);
	stream.on ('data', function (row) {
	  if (tables.indexOf(row[0]) === -1) tables.push (row[0]);
	});
	stream.on ('error', function (err) {
		// TODO: handler error
		console.log('GET TABLES ERR',err);
		var parsed = err.toString().match(/Table\s(.*) doesn/);
                if (parsed && parsed[1]){
                   console.log('Create Table!',parsed);
                   try {
                       clickhouse.querying(createTable(dbName,parsed[1])).then((result) => console.log(result) )
                       if(res) res.sendStatus(resp_empty);
                   } catch(e) { if (res) res.sendStatus(500) }

                } else {
                        return;
                }
		return false;
	});
	stream.on ('end', function () {
		if (debug) console.log('RELOAD TABLES:',tables);
		return tables;
	});
}

/* HTTP Helper */
const axios = require('axios');
const fwd = axios.create({ timeout: 5000 })

var express = require('express')
  , http = require('http')
  , path = require('path')
  , util = require('util');

var app = express();

function rawBody(req, res, next) {
  req.setEncoding('utf8');
  req.rawBody = '';
  req.on('data', function(chunk) {
    req.rawBody += chunk;
  });
  req.on('end', function(){
    next();
  });
}

app.set('port', process.env.PORT || 8686);
app.use(rawBody);

/* Write Handler */

app.post('/write', function(req, res) {
  if (debug) console.log('RAW: ' , req.rawBody);
  if (debug) console.log('QUERY: ', req.query);
  if (!req.query||!req.rawBody) return;

  // Use DB from Query, if any
  if (req.query.db) {
	var dbName = req.query.db;
	if (debug) console.log('DB',dbName )
	if (databaseCache.indexOf(dbName) === -1) initialize(dbName);
  	// Re-Initialize Clickhouse Client
	clickhouse_options.queryOptions.database = dbName;
  	ch = new ClickHouse(clickhouse_options);
  } else { ch =  new ClickHouse(clickhouse_options); }

  if (subscriptions[dbName]) {
	fwd.post(subscriptions[dbName].target, req.rawBody).catch(err => console.error('Subscription delivery failed ==========', err))
  }

  var queries = req.rawBody.split("\n");
  queries.forEach(function(rawBody){
	  if (!rawBody || rawBody == '') return;
	  var query = lineParser(rawBody);
	    query.parsed.fields.forEach(function(field){
		for (var key in field){
		  var unique = JSON.parse(JSON.stringify(query.parsed.tags)); unique.push({"__name__":key});
		  var uuid = JSON.stringify(unique);
		  var finger = fingerPrint(uuid);
		  if(!labels.get(finger,1)[0]){
		  	bulk_labels.add(finger,[new Date().toISOString().split('T')[0], finger, query.parsed.measurement, key, query.t, query.tv, uuid ]);
			labels.add(finger,key);
		  }

		}
	    });

	  query.parsed.db = dbName;

	  if (query.measurement) table = query.measurement;
	  if (tables.indexOf(query.parsed.measurement) === -1) {
		  console.log('Creating new table...',query.parsed.measurement)
		  try {
			ch.querying(createTable(dbName,query.parsed.measurement))
				.then((result) => sendQuery(query,true) )
				tables.push(query.parsed.measurement);
				getTables(dbName);
		  } catch(e) { sendQuery(query,true) }
	  } else {
		  sendQuery(query,false);
	  }
  });

  
  res.sendStatus(204);
});

var sendQuery = function(query,reload){
	  if (debug) console.log(query);
	  query.parsed.fields.forEach(function(field){
		for (var key in field){
		  var unique = JSON.parse(JSON.stringify(query.parsed.tags)); unique.push({"__name__":key});
		  var uuid = JSON.stringify(unique);
		  var ts = new Date(query.parsed.timestamp/1000000).getTime() || new Date().getTime();
		  var target = query.parsed.db ? query.parsed.db + "." + query.parsed.measurement : query.parsed.measurement;
		  var floatv = parseFloat(field[key]);
		  if (!floatv) {
		  	var values = [ parseInt(fingerPrint(uuid)), ts, key, field[key] || "" ];
			bulk_string.add(target, values);
		  } else {
		  	var values = [ parseInt(fingerPrint(uuid)), ts, parseFloat(field[key]) || 0, key || "" ];
			bulk_float.add(target, values);
		  }
		}
	  })
}

var databases = [];
app.all('/query', function(req, res) {
  if (debug) console.log('QUERY:', req.query.q, req.rawBody);
	// Temporarily nullify group by time definition for parser incompatibility
	if (req.query.q && req.query.q.includes('GROUP BY ')) req.query.q = req.query.q.replace(/GROUP BY time.*\)/, " FILL(null)");
	if (req.rawBody && req.rawBody.includes('GROUP BY ')) req.rawBody = req.rawBody.replace(/GROUP BY time.*\)/, " FILL(null)");

	// Temporarily nullify redundant time definition in latest Chronograf
	if (req.rawBody && req.rawBody.includes('AND time < now()')){
		var timeRange = req.rawBody.match(/time.+now\(\)(.*)AND time.+now\(\)/g)
		req.rawBody = req.rawBody.replace("AND time < now()","");
	}

  var rawQuery;
  try {
	  if(req.query.q) { rawQuery = req.query.q; }
          else if(req.rawBody) { rawQuery =  unescape( req.rawBody.replace(/^q=/,'').replace(/\+/g,' ') ); }

	  // Trim, multi-line
	  rawQuery = rawQuery.trim();

          if (rawQuery.startsWith('CREATE DATABASE')) {

		console.log('TRYING... ',req.query);
		if (req.query.db && req.query.db != "") {
			var db = req.query.db.replace(".","");
		} else if (req.query.q) {
			var db = req.query.q.match(/CREATE DATABASE \"?([^\s]*)\"?\s?/)[1] || false;	
		}
		if (db) {
	                 console.log('Create Database!',db);
	                 try {
	                       	// clickhouse.querying('CREATE DATABASE IF NOT EXISTS "'+db+'"').then((result) => databases.push(db) )
				initialize(db);
	                       	if(res) res.send(resp_empty);
	                 } catch(e) { 
				console.error(e);
				if (res) res.sendStatus(500) 
			 }

		} else {
			console.log('No Database Name!');
			res.sendStatus(204);
		}

          } else if (rawQuery.startsWith('SHOW RETENTION')) {
		var data = { "results": [] };
		// temporarily feed a faux retention policy
		databaseCache.forEach(function(db,i){
	  	    data.results.push({
		      "statement_id": i,
		      "series": [
		        {
		          "columns": [
		            "name",
		            "duration",
		            "shardGroupDuration",
		            "replicaN",
		            "default"
		          ],
		          "values": [
		            [
		              "autogen",
		              "0s",
		              "168h0m0s",
		              1,
		              true
		            ]
		          ]
		        }
		      ]
		    });

		});
		res.send(data);

          } else if (rawQuery.startsWith('SHOW FIELD KEYS')) {

		var parsed = rawQuery.match(/SHOW FIELD KEYS FROM "(.*)"."(.*)"/);
		if (parsed && parsed[1] && parsed[2]){
			if (debug) console.log('get fields for',parsed[2],req.query.db);
			var response = [];
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("select name from time_series WHERE measurement='" +parsed[2] +"' GROUP BY name");
			stream.on ('data', function (row) {
			  	response.push ([row[0],"float"]);
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":[{"name":parsed[2],"columns":["fieldKey","fieldType"],"values":response }]}]};
				res.send(results);
			});

		} else {
		    var parsed = rawQuery.match(/SHOW FIELD KEYS FROM "(.*)"/);
		    if (parsed && parsed[1]){
			if (debug) console.log('get fields for',parsed[1],req.query.db);
			var response = [];
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("select name from time_series WHERE measurement='" +parsed[1] +"' GROUP BY name");
			stream.on ('data', function (row) {
			  	response.push ([row[0],"float"]);
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":[{"name":parsed[1],"columns":["fieldKey","fieldType"],"values":response }]}]};
				res.send(results);
			});

		    }

		}

          } else if (rawQuery.startsWith('SHOW TAG KEYS')) {

		var parsed = rawQuery.match(/SHOW TAG KEYS FROM \"(.*)\"\.\"(.*)\"\s?/);
		if (parsed && parsed[1] && parsed[2]){
			if (debug) console.log('get fields for',parsed[2],req.query.db);
			var response = [];
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("SELECT measurement, labelname from time_series ARRAY JOIN labelname WHERE measurement='"+parsed[2]+"' GROUP BY measurement,labelname");
			stream.on ('data', function (row) {
			  response.push ([ row[1] ]);
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":[{"name":parsed[2],"columns":["tagKey"],"values":response }]}]}
				res.send(results);
			});

		} else {

		    var parsed = rawQuery.match(/SHOW TAG KEYS FROM "(.*)"/);
		    if (parsed && parsed[1]){
			if (debug) console.log('get fields for',parsed[1],req.query.db);
			var response = [];
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("SELECT measurement, labelname from time_series ARRAY JOIN labelname WHERE measurement='"+parsed[1]+"' GROUP BY measurement,labelname");
			stream.on ('data', function (row) {
			  response.push ([ row[1] ]);
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":[{"name":parsed[1],"columns":["tagKey"],"values":response }]}]}
				res.send(results);
			});
		    }
                }

          } else if (rawQuery.startsWith('SHOW TAG VALUES FROM') && rawQuery.includes('WITH KEY IN')) {

		var parsed = rawQuery.match(/SHOW TAG VALUES FROM \"(.*)\"\.\"(.*)\" WITH KEY IN (.*)/);
		if (parsed && parsed[1] && parsed[2]){
			if (debug) console.log('get tag values for',parsed[2],req.query.db);
			var response = [];
			var keys = parsed[3].replaceAll('"',"'");
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("SELECT labelname,labelvalue from time_series ARRAY JOIN labelname,labelvalue WHERE measurement='"+parsed[2]+"' AND labelname IN "+keys+" GROUP BY labelname,labelvalue");
			stream.on ('data', function (row) {
			  	response.push( { name: row[0], columns: ['key','value'], values: [ [row[0], row[1] ] ] } );
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":response }]};
				res.send(results);
			});

		} else {
		   // Legacy Query
		   var parsed = rawQuery.match(/SHOW TAG VALUES FROM \"(.*)\" WITH KEY IN (.*)/);
		   if (parsed && parsed[1] && parsed[2]){
			if (debug) console.log('get tag values for',parsed[1],req.query.db);
			var response = [];
			var keys = parsed[2].replaceAll('"',"'");
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("SELECT labelname,labelvalue from time_series ARRAY JOIN labelname,labelvalue WHERE measurement='"+parsed[1]+"' AND labelname IN "+keys+" GROUP BY labelname,labelvalue");
			stream.on ('data', function (row) {
			  	response.push( { name: row[0], columns: ['key','value'], values: [ [row[0], row[1] ] ] } );
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":response }]};
				res.send(results);
			});
		   }
		}

          } else if (rawQuery.startsWith('SHOW TAG VALUES FROM')) {

		var parsed = rawQuery.match(/SHOW TAG VALUES FROM \"(.*)\"\.\"(.*)\"/);
		if (parsed && parsed[1] && parsed[2]){
			if (debug) console.log('get tag values for',parsed[2],req.query.db);
			var response = [];
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("SELECT labelname,labelvalue from time_series ARRAY JOIN labelname,labelvalue WHERE measurement='"+parsed[2]+"' GROUP BY labelname,labelvalue");
			stream.on ('data', function (row) {
			  	response.push( { name: row[0], columns: ['key','value'], values: [ [row[0], row[1] ] ] } );
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":response }]};
				res.send(results);
			});

		} else {
		   // Legacy Query
		   var parsed = rawQuery.match(/SHOW TAG VALUES FROM \"(.*)\"/);
		   if (parsed && parsed[1] && parsed[2]){
			if (debug) console.log('get tag values for',parsed[1],req.query.db);
			var response = [];
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			var stream = tmp.query("SELECT labelname,labelvalue from time_series ARRAY JOIN labelname,labelvalue WHERE measurement='"+parsed[1]+"' GROUP BY labelname,labelvalue");
			stream.on ('data', function (row) {
			  	response.push( { name: row[0], columns: ['key','value'], values: [ [row[0], row[1] ] ] } );
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":response }]};
				res.send(results);
			});
		   }
		}

          } else if (rawQuery.startsWith('SHOW MEASUREMENTS')) {
		if (req.query.db) {
			if (debug) console.log('get measurements for',req.query.db);
			var response = [];
			clickhouse_options.queryOptions.database = req.query.db;
		  	// Re-Initialize Clickhouse Client
		  	var tmp = new ClickHouse(clickhouse_options);
			//var stream = tmp.query('SHOW TABLES');
			var stream = tmp.query('select measurement from time_series GROUP by measurement');
			stream.on ('data', function (row) {
			  response.push (row);
			});
			stream.on ('error', function (err) {
				// TODO: handler error
				console.error('GET DATA ERR',rawQuery,err);
			});
			stream.on ('end', function () {
				var results = {"results":[{"statement_id":0,"series":[{"name":"measurements","columns":["name"],"values":response }]}]}
				res.send(results);
			});
		}

          } else if (rawQuery.startsWith('SHOW DATABASES')) {
		var response = [];
		var stream = clickhouse.query('SHOW DATABASES');
		stream.on ('data', function (row) {
		  response.push (row);
		});
		stream.on ('error', function (err) {
			// TODO: handler error
			console.error('GET DATA ERR',rawQuery,err);
		});
		stream.on ('end', function () {
			databases = response;
			if (debug) console.log(databases)
			var results = {"results":[{"statement_id":0,"series":[{"name":"databases","columns":["name"], "values": response } ]} ]};
			res.send(results);
		});

          } else if (rawQuery.startsWith('CREATE SUBSCRIPTION')) {

		// CREATE SUBSCRIPTION "kapacitor-34435716-7d1c-46ad-a0c2-8ced9873dff3" ON chronograf.autogen DESTINATIONS ANY 'http://kapacitor:9092'
		   var parsed = rawQuery.match(/CREATE SUBSCRIPTION \"(.*)\" ON (.*) DESTINATIONS ANY \'(.*)\'/);
		   if (parsed && parsed[1] && parsed[2] && parsed[3]){
			console.log('SUBSCRIPTION FOR '+parsed[2]+" towards "+parsed[3])
			subscriptions[parsed[2]] = { target: parsed[3], id: parsed[1] };
			subscriptions_cache.add(parsed[2], parsed);
		   }

          } else if (rawQuery.startsWith('SELECT')) {

		// Drop Limit, temporary measure!
		rawQuery = rawQuery.replace(/LIMIT [0-9]{1,9}/, "");
		if (debug||exception) console.log('OH OH SELECT!',rawQuery);
                var parsed = ifqlparser.parse(rawQuery.trim());
		if (debug||exception) console.log('OH OH PARSED!',JSON.stringify(parsed));
		var settings = parsed.parsed.table_exp.from.table_refs[0];
		var where = parsed.parsed.table_exp.where;
		var groupby = parsed.parsed.table_exp.groupby;
		// Breakdown
		console.log('TYPE: '+ parsed.parsed.type);
		console.log('DB: '+ settings.db);
		console.log('TABLE: '+ settings.table);

		// TIMERANGE MATCHING
                try {
		  if (where.condition){
                    if( where.condition.right.left.name
                        && where.condition.right.left.name.value == 'now'
                        && where.condition.right.right && where.condition.right.right.value
                        && where.condition.right.right.range){
                            	var from_ts = "toDateTime( now()-" +toTime(where.condition.right.right.value+where.condition.right.right.range.data_type).seconds()+  ")";
                            	var to_ts = "toDateTime( now() )";
                    } else if(where.condition.left.left && where.condition.left.left.value == 'time' && where.condition.right && where.condition.right.left.value == 'time') {
			if (where.condition.left.right.value && where.condition.right.right.value){
                        	var from_ts = "toDateTime(" + parseInt(where.condition.left.right.value/tsDivide) + ")";
                        	var to_ts = "toDateTime(" + parseInt(where.condition.right.right.value/tsDivide)  + ")";
			} else if (where.condition.left.right.string && where.condition.right.right.string){
                        	var from_ts = "toDateTime(toUnixTimestamp('"+formatDate( new Date(where.condition.left.right.string))  +"'))";
                        	var to_ts =   "toDateTime(toUnixTimestamp('"+formatDate( new Date(where.condition.right.right.string)) +"'))";
			}
                    } else {
                        	var from_ts = where.condition.left.value == 'time' ? "toDateTime("+parseInt(where.condition.right.left.name.from_timestamp/1000)+")" : 'toDateTime(now()-300)';
                        	var to_ts = where.condition.left.value == 'time' ? "toDateTime("+parseInt(where.condition.right.left.name.to_timestamp/1000)+")" : 'toDateTime(now())';
                    }
                  }
                } catch(e){
                        	console.log('DATE RANGE ERR',e);
                        	var from_ts = 'toDateTime(now()-3600)';
                        	var to_ts = 'toDateTime(now())';
                }
		if (debug) console.log('TIME RANGE: '+ from_ts, to_ts);

		var response = [];

		// OPEN PREPARE
		var prepare = "SELECT * FROM ";
		if(parsed.returnColumns[0].sourceColumns[0].value) {
			var inner = []
			var filters = [];
			if(where.condition.right && where.condition.right.exprs){
				where.condition.right.exprs.forEach(function(cond){
					if(cond.left.left.value && cond.left.right.string){
						filters.push({"name":cond.left.left.value, "value": cond.left.right.string});
					}
				});
			}

			parsed.returnColumns.forEach(function(source,i){
			  var nameas = source.name;
			  source.sourceColumns.forEach(function(metric_id){
				if (metric_id.value){
				   var tmp = "SELECT toUnixTimestamp(toStartOfMinute(toDateTime(timestamp_ms/1000))) as minute, name, avg(value) as mean, labelname, labelvalue, message "
					+" FROM "+settings.table+" ANY INNER JOIN ("
						+"SELECT fingerprint, name, labelname, labelvalue"
						+" FROM ("
							+" SELECT fingerprint, name, labelname, labelvalue"
							+" FROM time_series FINAL ARRAY JOIN labelname,labelvalue"
							+" PREWHERE name='" + metric_id.value + "'";
						//	+" AND name IN ('"+ metric_id.value +"')"
						//	+" AND hasAny(['gid'], labelname) = 1";
							if (filters.length > 0) filters.forEach(function(filter){
								tmp+=" AND labelvalue[arrayFirstIndex(x -> (x = '"+filter.name+"'), labelname)] = '"+filter.value+"'";
							})
							tmp+=") ";
				//	tmp+=" WHERE labelname='" +metric_id.value+ "' ";
					tmp+=" )"
					+" USING(fingerprint)"
					+" PREWHERE minute BETWEEN "+from_ts+ " AND " + to_ts
					+" GROUP by fingerprint, minute, name, labelname, labelvalue, message ORDER by minute";

				   inner.push(tmp);
				}
			  })
			})
			prepare += " ( "+inner.join(' UNION ALL ') + ") ";
		}
		prepare += " ORDER BY minute,name,labelname,labelvalue,message"

		// CLOSE PREPARE

		console.log('NEW QUERY',prepare);

		if (settings.db) {
			clickhouse_options.queryOptions.database = settings.db;
		} else if (settings.database && settings.database != '') {
			clickhouse_options.queryOptions.database = settings.database ? settings.database.replace('.autogen','') : '';
		}

		var metrics = {};
		var xtags = {};
		var template = {"statement_id":0,"series":[{"name": settings.table ,"columns":[] }]};

	  	// Re-Initialize Clickhouse Client
	  	var tmp = new ClickHouse(clickhouse_options);
		var stream = tmp.query(prepare);
		stream.on ('data', function (row) {

		  var tmp = [ row[0]*1000, row[5] || row[2] ];

		  if(!xtags[row[1]]) {
			 xtags[row[1]] = {};
			 if(!xtags[row[1]][row[3]]) {
				xtags[row[1]][row[3]] = {}

			 	if(!xtags[row[1]][row[3]][row[4]]) {
					xtags[row[1]][row[3]][row[4]] = []
					if (debug) console.log('Float Tag Created!');
				}
			}
		  }
		  if ( xtags[row[1]][row[3]][row[4]] ) xtags[row[1]][row[3]][row[4]].push(tmp);

		});
		stream.on ('error', function (err) {
			// TODO: handler error
			console.error('GET DATA ERR',rawQuery,err);
		});
		stream.on ('end', function () {
			var results = {"results": []};

			Object.keys(xtags).forEach(function(metric,i) {
		      	  var line = {"statement_id":i,"series":[{"name": settings.table, "tags":false, "values": false, "columns": ["time", metric] }]};
			  Object.keys(xtags[metric]).forEach(function(xtag,t) {
			    Object.keys(xtags[metric][xtag]).forEach(function(xvalue,v) {
				console.log('stripe',xtags,metric,xtag,xvalue);
				var tags = {}; tags[xtag] = xvalue;
				line.series[0].tags = tags;
				line.series[0].values = xtags[metric][xtag][xvalue];
			      	results.results.push(line);
			    });
			  });
			});


			res.send(results);
		});

          } else if (rawQuery.startsWith('SHOW SUBSCRIPTIONS')) {

		var mock = {
		    "results": [
		        {
		            "statement_id": 0
		        }
		    ]
		};
		res.send(mock);

          } else {
		try {
			console.log('UNSUPPORTED',rawQuery);
			res.send(resp_empty);
			
		} catch(e) { console.error('UNSUPPORTED',e) }
          }
  } catch(e) {
          console.log(e);
          res.send(resp_empty);
  }
	
});

/* INFLUXDB PING EMULATION */
app.get('/ping', (req, res) => {
	if (debug) console.log('PING req!');
	clickhouse.pinging().then((result) => { res.sendStatus(204) } )
})

http.createServer(app).listen(app.get('port'), function(){
  console.log("ClickFlux server listening on port " + app.get('port'));
});

process.on('unhandledRejection', function(err, promise) {
    if (debug) console.error('Error:',err);
});

