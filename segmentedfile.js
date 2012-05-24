"use strict";

var fs = require('fs')

var fsExt = require('fs-ext');

var EventEmitter = require('events').EventEmitter;

var _ = require('underscorem')
var parsicle = require('parsicle');

var segmentationParser = parsicle.make(function(parser){

	parser('discard', 'int', function(p){})
	parser('segment', 'int', function(p){})
})

exports.open = function(path, readCb, segmentCb, cb){
	if(arguments.length === 2){
		cb = readCb;
		readCb = undefined;
	}else{
		_.assertLength(arguments, 4);
	}
	
	_.assertString(path)
	
	var segments = [];
	var discarded = [];

	var totalOffset = 0;

	var reader = segmentationParser.binary.stream.makeReader({
		discard: function(d){
			_.assertInt(d);
			_.assertInt(segments[d])
			//console.log('*read discard def: ' + d)
			discarded[d] = true;
		},
		segment: function(s){
			_.assertInt(s);
			//console.log('*read segment def: ' + s)
			segments.push(s);
			totalOffset += s;
		}
	})
	
	
	var mws;
	
	function makePausable(ws){
		var p = 0;
		ws.pause = function(){
			++p;
		}
		ws.resume = function(){
			--p;
			if(p === 0) flush()
		}
		var bufs = []
		var oldWrite = ws.write.bind(ws)
		function flush(){
			bufs.forEach(function(buf){
				oldWrite(buf)
			})
			bufs = []
		}
		ws.write = function(buf){
			_.assertBuffer(buf)
			if(p > 0) bufs.push(buf)
			else oldWrite(buf)
		}
		ws.end = function(cb){
			//_.errout('TODO')
			_.assertEqual(p, 0)
			//ws.end(cb)
			cb()
		}
		return ws;
	}
	
	var segmentationFd
	
	console.log('locking on ' + path+'.segmentation...')
	fs.open(path+'.segmentation', 'a+', function(err, fd){
		if(err) throw err;
		_.assertDefined(fd)
		segmentationFd = fd
		fsExt.flock(fd, 'exnb', function (err) {//take out an exclusive lock on segmentation to ensure only one writer
			if(err){
				err.path = path+'.segmentation';
				throw err;
			}
			
			//console.log('...got lock.');
			fs.fstat(fd, function(err, stats){
				if(err) throw err;
				//console.log('opened segmentation, file is: ' + stats.size)
				readAll(fd, stats.size, reader, function(){
					//reader.assertUsedAll(stats.size)
					_.assertEqual(stats.size, reader.manyBytesRead)
					mws = makePausable(fs.createWriteStream(path+'.segmentation', {flags: 'a+'}));

					loadWriteStreamForLastSegment(finish)
				});
			})
		})
	})

	var ws;
	var currentSegmentSize;

	var segmentIsFinishing = {}
		
	function switchWriteStream(isNew, newPath, openCb){
		var oldWs = ws;
		var lws = fs.createWriteStream(newPath, {flags: isNew ? 'w' : 'a'});
		var drainingSync = []
		var draining = false;
		var oldWrite = lws.write.bind(lws);
		
		lws.on('open', function(){
			if(openCb) openCb()
		})

		var written = 0;
		var writtenSinceLastSync = 0;
		
		lws.write = function(bufOrString, encoding){
			if(_.isString(bufOrString)){
				encoding = encoding || 'utf8'
				bufOrString = new Buffer(bufOrString, encoding);
			}
			written += bufOrString.length
			console.log('ws file: ' + newPath)
			console.log('wrote to oldWrite: ' + bufOrString.length)
			var res = oldWrite(bufOrString)
			if(!res) draining = true;
		}
		
		var fd;
		var delayedSync;
		var fsyncWaiter

		function initFsyncWaiter(){
			fsyncWaiter = _.doOnce(
				function(written){return written;},
				function(w, cb){
					fs.fsync(fd, function(err){
						if(err) throw err;

						writtenSinceLastSync = w
						cb()
					})
				},
				function(count){
					if(count === 0) closeFd()
				})
		}
		function openFd(){
			_.assertUndefined(delayedSync)
			delayedSync = []
			fs.open(newPath, 'a+', function(err, theFd){
				if(err) throw err;
				fd = theFd;
				initFsyncWaiter()
				processDelayedSync()
			})
		}
		function closeFd(){
			var theFd = fd;
			fd = undefined;
			fsyncWaiter = undefined;
			delayedSync = undefined
			fs.close(theFd, function(err){if(err) throw err;});
		}
		function sync(written, cb){
			if(fd === undefined){
				if(delayedSync === undefined){
					openFd()
				}
				delayedSync.push(cb);
			}else{
				fsyncWaiter(written, cb)
			}
		}
		function processDelayedSync(){
			var ds = delayedSync
			delayedSync = undefined;
			if(ds.length === 0){
				close();
				return;
			}
			ds.forEach(function(cb){
				fsyncWaiter(written, cb)
			})
		}

		var closed = false;
		
		lws.sync = function(cb){
			if(oldWs){
				oldWs.sync(function(){
					oldWs = undefined;
					lws.sync(cb)
				})
				return;
			}
			if(written === writtenSinceLastSync){
				process.nextTick(cb)
				return;
			}
			
			if(draining){
				drainingSync.push(cb)
			}else{
				sync(written, cb)
			}
		}
		
		var oldEnd = lws.end.bind(lws);
		lws.end = function(){
			if(draining){
				lws.once('drain', function(){
					oldEnd()
				});
			}else{
				oldEnd()
			}
		}
		
		lws.on('drain', function(){
			if(draining){
				draining = false;
				drainingSync.forEach(lws.sync)
				drainingSync = []
			}
		})

		lws.on('close', function(){
			_.assertNot(draining)
			closed = true;
		})
		ws = lws;
	}
	
	function loadWriteStreamForLastSegment(doneCb){
		var lastPath = path+'.'+segments.length+'.segment'

		switchWriteStream(false, lastPath, function(){

			fs.stat(lastPath, function(err, stat){
				if(err) throw err;
				//console.log('last path(' + lastPath + ') size: ' + stat.size)
				currentSegmentSize = stat.size;
			
				doneCb()
			})
		})
	}
	
	var todoDiscard = []
	
	function finish(){
		//console.log('in finish')
		
		function readOneSegment(){
			if(fdIndex > segments.length){
				finalFinish();
				return;
			}
			//_.assert(fdIndex < segments.length)
			var len = segments[fdIndex];
			var d = discarded[fdIndex];
			segmentCb(fdIndex, !!d)
			if(len === undefined){
				len = currentSegmentSize;
				_.assertEqual(fdIndex, segments.length);
				//console.log('(last)');
			}
			//totalOffset += len;
			
			if(d){
				++fdIndex;
				return true;
			}else{
				//console.log('read segment: ' + len + ' ' + fdIndex + ' ' + d)

				//console.log('reading all')
				if(len === 0 && fdIndex < segments.length){// || fd === undefined){
					todoDiscard.push(fdIndex)
					++fdIndex;
					return true;
				}else{
					//_.assertDefined(fd)
					var segmentPath = path+'.'+fdIndex+'.segment';
					var index = fdIndex;
					++fdIndex;
					fs.open(segmentPath, 'r', function(err, fd){
						if(err){
							if(err.code === 'ENOENT'){
								todoDiscard.push(index)
								readMore()
								return;
							}else{
								throw err;
							}
						}
						readAll(fd, len, readCb, function(){
							fs.close(fd, function(err){if(err) throw err;});
							readMore()
						})
					})
				}
			}
		}
		function readMore(){
			while(readOneSegment()){}
		}
		
		if(readCb){
			//totalOffset = 0;
			var fdIndex = 0;
			
			readMore()
		}else{
			finalFinish();
		}
	}
	
	function readSegment(segmentIndex, dataCb, doneCb){
		_.assertInt(segmentIndex)
		_.assert(segmentIndex < segments.length)
		var fd;
		fs.open(path+'.'+segmentIndex+'.segment', 'r', function(err, theFd){
			if(err) throw err;
			fd = theFd;
			finish();
		})
		function finish(){
			var len = segments[segmentIndex];
			_.assertInt(len)
			//console.log('reading segment ' + segmentIndex + ' ' + len)
			readAll(fd, len, dataCb, after, path+'.'+segmentIndex+'.segment')
						
			function after(){
				fs.close(fd, function(err){if(err) throw err;});
				doneCb()
			}
		}
	}
	
	function discardSegment(segmentId){
		_.assertInt(segmentId)
		//console.log(segmentId +'<'+ segments.length)
		_.assert(segmentId < segments.length)
		
		function finishDiscard(){

			var segmentPath = path+'.'+segmentId+'.segment'
			fs.unlink(segmentPath, function(err){
				if(err){
					if(err.code === 'ENOENT'){
						console.log('WARNING: tried to unlink non-existent file: ' + segmentPath);
					}else{
						throw err;
					}
				}
				mw.discard(segmentId)//deleting, then discarding, ensures we never have discarded but undeleted files left orphaned.
				mw.flush()
				//console.log('deleted segment')
			})			
		}
		
		if(!discarded[segmentId]){
			
			discarded[segmentId] = true;
			
			if(segmentIsFinishing[segmentId]){
				segmentIsFinishing[segmentId].push(finishDiscard)
			}else{
				finishDiscard();
			}
		}else{
			_.errout('segment does not exist or was already discarded');
		}
	}
	var mw;
	
	function finalFinish(){
	
		mw = segmentationParser.binary.stream.makeWriter(mws);
		
		//console.log('in finalFinish')

		var w = new EventEmitter();
		
		w.sync = function(cb){
			ws.sync(cb)
		}
		
		todoDiscard.forEach(discardSegment)
		todoDiscard = undefined;
		
		var raSegmentOpen = _.doOnce(
			function(segmentIndex){return segmentIndex;},
			function(segmentIndex, cb){
				var segmentPath = path+'.'+segmentIndex+'.segment'
				fs.open(segmentPath, 'r', function(err, fd){
					if(err) throw err;
					cb(fd)//TODO optimize - reclaim fds - prevent fd leak
				})
			})
		
		//var readOut = 0;
		
		_.extend(w, {
			readRange: function(pos, len, cb){//must not span multiple segments
				var off = 0;
				var remainingOff;
				for(var i=0;i<segments.length;++i){
					var segmentLength = segments[i];
					off += segmentLength;
					if(pos < off){
						if(pos+len > off){
							throw new Error('length must be invalid, it crosses segment boundaries: ' + (pos+len) + ' > ' + off);
						}
						remainingOff = pos - (off-segmentLength)
						break;
					}
				}
				if(discarded[i]){
					throw new Error('read range lies within discarded segment')
				}
				if(i === segments.length && pos+len > off + currentSegmentSize){
					throw new Error('readRange extends beyond the bounds of the file: ' + 
						pos+'+'+len+' > ' + off + '+' + currentSegmentSize+' (' + (pos+len)+' > '+(off+currentSegmentSize)+')');
				}
				
				var segmentPath = path+'.'+i+'.segment'

				raSegmentOpen(i, function(fd){
					//console.log('reading at ' + remainingOff + ' ' + i)
					/*++readOut
					if(readOut % 10000 === 0 || readOut < 10){
						console.log('more out: ' + readOut)
					}*/
					readOffsetEntirely(fd, remainingOff, len, function(buf){
						//console.log('...done reading at ' + remainingOff + ' ' + i)
						/*--readOut
						if(readOut % 1000 === 0 || readOut < 10){
							console.log('still out: ' + readOut)
						}*/
						cb(buf)
					});
				})
			},
			readSegment: function(segmentIndex, dataCb, doneCb){
				if(segmentIsFinishing[segmentIndex]){
					segmentIsFinishing[segmentIndex].push(function(){
						readSegment(segmentIndex, dataCb, doneCb)
					})
				}else{
					readSegment(segmentIndex, dataCb, doneCb)
				}
			},
			write: function(buf){
				currentSegmentSize += buf.length;
				var to = totalOffset;
				totalOffset += buf.length;
				console.log('segmented file wrote to ws: ' + buf.length)
				ws.write(buf)
				return to;
			},
			getSegmentSize: function(segmentId){
				_.assertInt(segmentId)
				_.assert(segmentId < segments.length)
				return segments[segmentId];
			},
			discard: discardSegment,
			segment: function(){
				//console.log('segmented! ' + currentSegmentSize)

				ws.end();
				segments.push(currentSegmentSize);

				var lastPath = path+'.'+segments.length+'.segment'
				var oldWs = ws;
				switchWriteStream(true, lastPath)
				
				mws.pause()//don't let the mw write the metadata until we've synced the data itself
				mw.segment(currentSegmentSize);
				var si = segments.length-1
				//console.log('finishing segment ' + si + ' ' + currentSegmentSize)
				currentSegmentSize = 0;
				segmentIsFinishing[si] = []
				//console.log('finishing ' + si)
				ws.sync(function(){
					//console.log('synced ' + si)	
					var list = segmentIsFinishing[si];
					list.forEach(function(cb){cb();})
					delete segmentIsFinishing[si];
					mws.resume()
					mw.flush()
				})
			},
			getCurrentSegmentSize: function(){
				return currentSegmentSize;
			},
			end: function(cb){
				var cdl = _.latch(3, function(){
					if(cb) cb();
				})
				_.assertDefined(segmentationFd)
				fsExt.flock(segmentationFd, 'un', function(err){
					if(err) throw err
					console.log('unlocked segmentation file: ' + path + '.segmentation')
					fs.close(segmentationFd, function(){
						cdl()
						mw.end(cdl)
						mws.end(cdl);
					})
				})
				//ws.end()
				//cdl()
			}
		})
		cb(w)
	}
}

function readOffsetEntirely(fd, pos, len, cb){
	var remaining = len;
	var fileOff = pos;
	var buf = new Buffer(len);
	function readBlock(){
		fs.read(fd, buf, 0, Math.min(remaining, buf.length), fileOff, function(err, bytesRead){
			if(err) throw err;
			//console.log('read: ' + bytesRead);
			fileOff += bytesRead;
			remaining -= bytesRead;
			if(remaining > 0){
				readBlock();
			}else{
				cb(buf)
			}
		})
	}
	readBlock();
}

function readEntirely(fd, len, cb){
	var remaining = len;
	var fileOff = 0;
	var buf = new Buffer(len);
	function readBlock(){
		fs.read(fd, buf, 0, Math.min(remaining, buf.length), fileOff, function(err, bytesRead){
			if(err) throw err;
			//console.log('read: ' + bytesRead);
			fileOff += bytesRead;
			remaining -= bytesRead;
			if(remaining > 0){
				readBlock();
			}else{
				cb(buf)
			}
		})
	}
	readBlock();
}

function readAll(fd, len, dataCb, doneCb, path){
	var remaining = len;
	var fileOff = 0;
	function readBlock(){
		var buf = new Buffer(Math.min(remaining, 1*1024*1024));
		fs.read(fd, buf, 0, buf.length, fileOff, function(err, bytesRead){
			if(err) throw err;
			
			if(bytesRead === 0){
				throw new Error('file is smaller than described: ' + fileOff + ' < ' + len + ' ' + path)
			}
			
			fileOff += bytesRead;
			remaining -= bytesRead;
			dataCb(buf.slice(0, bytesRead));

			tryDone()
		})
	}
	function tryDone(){
		if(remaining > 0){
			readBlock();
		}else{
			doneCb();
		}
	}
	tryDone();
}
